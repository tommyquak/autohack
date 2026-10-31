"""Assured triage: a certificate for every decision, and a live audit of the safety invariants.

"Second Look can never hide a Critical" is a claim about every single decision. This module makes it checkable:

    certify(row, pred, artifact) -> dict   why one CDM's tier holds: rules fired, whether the model was allowed to act
                                           and why not, its score against the threshold, and four invariants
    to_escalate(row, certificate)  -> dict what would move the CDM to the next tier up (margin to each threshold)
    reasons(row, certificate)      -> list plain-English reasons, including missing input and demotion
    audit(doc, artifact=None)      -> dict re-verifies the invariants over every event (and every CDM in each
                                           event's history) of an events.json, from its inputs, not from its labels;
                                           also completeness, strict tier types, latest == last history CDM, and one
                                           threshold (events.json's model_evidence, and the loaded artifact's)

The per-CDM model score is the one thing audit cannot re-derive: it needs each CDM's full allowed inputs and its
event-history features, which events.json does not carry. audit checks the stored score against a threshold it ties
to model_evidence and to the loaded artifact.

Nothing here reads `risk` (the label) or `true_tier`. Certificates describe decisions; they never change one: the tier
always comes from triage.model.predict.

Invariants (each true/false per certificate, re-checked by audit):
- never_demotes_critical            Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km) stays Critical
- not_below_miss_rule               the tier is never below the miss-distance tier
- unusable_uncertainty_not_demoted  placeholder, missing or non-positive sigma, unknown object type, missing or
                                    negative time to TCA, missing relative speed / position, or missing Pc bound /
                                    miss distance (triage.model.input_flags): never below the rule tier
- demotion_below_threshold          any tier below the rule tier is a model demotion of an eligible CDM whose score
                                    is below the stored threshold
"""

import math
from collections.abc import Mapping

import numpy as np

from triage.data import CATEGORIES
from triage.features import SIGMA_SENTINEL_M
from triage.model import TRUSTED_INPUTS
from triage.tiers import (
    MISS_CRITICAL_M,
    MISS_ELEVATED_M,
    RISK_CRITICAL,
    RISK_ELEVATED,
    TIER_NAMES,
    Tier,
    miss_tier,
    pc_tier,
)
from triage.tiers import reasons as rule_reasons

INVARIANTS = (
    "never_demotes_critical",
    "not_below_miss_rule",
    "unusable_uncertainty_not_demoted",
    "demotion_below_threshold",
)
DECISIONS = ("kept", "demoted", "not eligible")


def _num(x) -> float:
    """float, with None / blank / non-numbers as NaN (missing)."""
    try:
        return float(x)
    except (TypeError, ValueError):
        return math.nan


def _clean(x: float) -> float | None:
    """JSON-safe number: NaN or infinite -> None."""
    return float(x) if x is not None and math.isfinite(x) else None


def _recall_target(artifact: dict | None) -> float:
    from triage.train import RECALL_TARGET  # local import: train pulls in scikit-learn

    cv = (artifact or {}).get("cv") or {}
    return float(cv.get("recall_target", RECALL_TARGET))


def certify(row: Mapping, pred: Mapping, artifact: dict | None) -> dict:
    """Certificate for one CDM decision.

    row: the CDM's allowed inputs (max_risk_estimate, miss_distance, c_sigma_r, t_sigma_r, c_object_type).
    pred: that row of triage.model.predict_detailed (pred_tier, p_elevated).
    artifact: the trained model artifact the prediction used, or None / {} for the rules alone.
    """
    pc, miss = _num(row["max_risk_estimate"]), _num(row["miss_distance"])
    sig_c, sig_t = _num(row["c_sigma_r"]), _num(row["t_sigma_r"])
    otype = row["c_object_type"]
    tier = int(pred["pred_tier"])

    pc_t, miss_t = int(pc_tier(pc)), int(miss_tier(miss))  # NaN fails every comparison -> 0, floored below
    missing = [c for c, v in (("max_risk_estimate", pc), ("miss_distance", miss)) if math.isnan(v)]
    # Same rows as triage.model.input_flags: never demoted, always flagged.
    sigma_missing = [c for c, v in (("c_sigma_r", sig_c), ("t_sigma_r", sig_t)) if math.isnan(v)]
    other_missing = [c for c in TRUSTED_INPUTS if math.isnan(_num(row.get(c)))]
    invalid = [f"{c} <= 0" for c, v in (("c_sigma_r", sig_c), ("t_sigma_r", sig_t)) if v <= 0]
    invalid += ["time_to_tca < 0 (after TCA)"] * (_num(row.get("time_to_tca")) < 0)
    placeholder = sig_c > SIGMA_SENTINEL_M or sig_t > SIGMA_SENTINEL_M
    unknown_type = not isinstance(otype, str) or otype not in CATEGORIES["c_object_type"]
    rule_tier = max(pc_t, miss_t, Tier.ELEVATED if missing else Tier.SAFE)  # unknown is never below Elevated

    fired = []
    if pc_t == Tier.CRITICAL:
        fired.append("pc_bound >= 1e-4")
    elif pc_t == Tier.ELEVATED:
        fired.append("pc_bound in [1e-6, 1e-4)")
    if miss_t == Tier.CRITICAL:
        fired.append("miss < 1 km")
    elif miss_t == Tier.ELEVATED:
        fired.append("miss in [1 km, 5 km]")
    fired += [f"{c} missing -> at least Elevated" for c in missing]

    # The model may act only on a CDM Elevated purely by the Pc upper bound, with usable, complete inputs
    # (triage.train.candidates, minus the rows triage.model.input_flags protects).
    if missing:
        why_not = f"missing input ({', '.join(missing)})"
    elif rule_tier == Tier.CRITICAL:
        why_not = "Critical"
    elif miss_t == Tier.ELEVATED:
        why_not = "Elevated by miss distance"
    elif pc_t == Tier.SAFE:
        why_not = "below threshold by rule (nothing to remove)"
    elif placeholder:
        why_not = "sigma placeholder (no usable covariance)"
    elif sigma_missing or other_missing:
        why_not = f"missing input ({', '.join(sigma_missing + other_missing)})"
    elif invalid:
        why_not = f"invalid input ({', '.join(invalid)})"
    elif unknown_type:
        why_not = "unknown object type"
    else:
        why_not = None
    candidate = why_not is None

    has_model = bool(artifact)
    score = _num(pred.get("p_elevated")) if candidate and has_model else math.nan
    threshold = float(artifact["threshold"]) if candidate and has_model else None
    score = None if math.isnan(score) else score
    decision = ("demoted" if tier < rule_tier else "kept") if candidate else "not eligible"

    flags = [f"{c} missing" for c in (*missing, *sigma_missing, *other_missing)] + invalid
    flags += ["sigma placeholder"] * placeholder + ["unknown object type"] * unknown_type
    unusable = bool(flags)
    invariants = {
        "never_demotes_critical": rule_tier < Tier.CRITICAL or tier == Tier.CRITICAL,
        "not_below_miss_rule": tier >= miss_t,
        "unusable_uncertainty_not_demoted": not unusable or tier >= rule_tier,
        "demotion_below_threshold": tier >= rule_tier
        or (candidate and score is not None and threshold is not None and score < threshold),
    }
    return {
        "tier": tier,
        "tier_name": TIER_NAMES[Tier(tier)],
        "rule_tier": int(rule_tier),
        "rule_tier_name": TIER_NAMES[Tier(rule_tier)],
        "rules_fired": fired,
        "candidate": candidate,
        "why_not_candidate": why_not,
        "input_flags": flags,
        "model": "trained" if has_model else "rules only",
        "model_score": score,
        "threshold": threshold,
        "recall_target": _recall_target(artifact),
        "decision": decision,
        "invariants": invariants,
        "holds": all(invariants.values()),
    }


def reasons(row: Mapping, cert: dict) -> list[str]:
    """Plain-English reasons for one CDM: the rules that fired, plus what missing input or the model did."""
    pc, miss = _num(row["max_risk_estimate"]), _num(row["miss_distance"])
    if math.isnan(pc) or math.isnan(miss):
        out = [r for r in rule_reasons(pc, math.inf) if r.startswith("Pc 10^")] if not math.isnan(pc) else []
        if math.isnan(pc):
            out.append("Pc upper bound missing: treated as at least Elevated and flagged for review")
        if math.isnan(miss):
            out.append("miss distance missing: treated as at least Elevated and flagged for review")
        else:
            out += [r for r in rule_reasons(-math.inf, miss) if r.startswith("miss")]
    else:
        out = rule_reasons(pc, miss)
    if cert["decision"] == "demoted":
        out.append(
            f"Model: Elevated only by the Pc upper bound with miss > 5 km; score {_fmt(cert['model_score'])} is below "
            f"the threshold {_fmt(cert['threshold'])}, so the over-warning is removed (below threshold, not 'no risk')"
        )
    other = [f for f in cert.get("input_flags", []) if f not in ("max_risk_estimate missing", "miss_distance missing")]
    if other:
        out.append(f"Untrusted input ({', '.join(other)}): never demoted below the rule tier")
    return out


def _fmt(x) -> str:
    return f"{x:.4f}" if isinstance(x, int | float) else "unknown"


def _r(x: float, nd: int) -> float | None:
    x = _clean(x)
    return None if x is None else round(x, nd)


def to_escalate(row: Mapping, cert: dict) -> dict:
    """Margin to the next tier up for one CDM: which threshold it would have to cross, and how far it is now."""
    tier = cert["tier"]
    pc, miss = _num(row["max_risk_estimate"]), _num(row["miss_distance"])
    now = {"miss_now_m": _r(miss, 1), "pc_bound_now_log10": _r(pc, 4)}
    if tier >= Tier.CRITICAL:
        return {"next_tier": None, **now, "any_of": [], "detail": "Already Critical, the top tier"}

    def miss_txt(limit: str) -> str:
        return f"miss distance {limit} (now {f'{miss:,.0f} m' if math.isfinite(miss) else 'unknown'})"

    def pc_txt(limit: str) -> str:
        return f"Pc upper bound reaches {limit} (now {f'1e{pc:.1f}' if math.isfinite(pc) else 'unknown'})"

    if tier == Tier.ELEVATED:
        return {
            "next_tier": TIER_NAMES[Tier.CRITICAL],
            "miss_must_drop_below_m": MISS_CRITICAL_M,
            **now,
            "pc_bound_must_reach_log10": RISK_CRITICAL,
            "miss_drop_needed_m": _r(miss - MISS_CRITICAL_M, 1),
            "pc_bound_rise_needed_decades": _r(RISK_CRITICAL - pc, 4),
            "any_of": [miss_txt("drops below 1,000 m"), pc_txt("1e-4")],
        }
    if cert["decision"] == "demoted":  # rule says Elevated; the model removed it, so its score is the gate
        return {
            "next_tier": TIER_NAMES[Tier.ELEVATED],
            "miss_must_drop_to_m": MISS_ELEVATED_M,
            **now,
            "model_score_must_reach": cert["threshold"],
            "model_score_now": cert["model_score"],
            "miss_drop_needed_m": _r(miss - MISS_ELEVATED_M, 1),
            "any_of": [
                miss_txt("drops to 5,000 m or less"),
                f"model score reaches the threshold {_fmt(cert['threshold'])} (now {_fmt(cert['model_score'])})",
                "the covariance becomes unusable or an input goes missing (such a CDM is never demoted)",
            ],
            "detail": "The Pc upper bound is already in the Elevated band; a bound at 1e-4 would make it Critical",
        }
    return {
        "next_tier": TIER_NAMES[Tier.ELEVATED],
        "miss_must_drop_to_m": MISS_ELEVATED_M,
        **now,
        "pc_bound_must_reach_log10": RISK_ELEVATED,
        "miss_drop_needed_m": _r(miss - MISS_ELEVATED_M, 1),
        "pc_bound_rise_needed_decades": _r(RISK_ELEVATED - pc, 4),
        "any_of": [miss_txt("drops to 5,000 m or less"), pc_txt("1e-6")],
    }


# ---------- audit: re-verify the invariants over a whole events.json ----------


def _arr(values) -> np.ndarray:
    return np.array([_num(v) for v in values], dtype=float)


def _tier(x) -> int:
    """A served tier must be an int in {0, 1, 2}. Anything else (2.5, 2.0, "2", True, null) becomes -1, which fails
    every floor check as well as `tiers_well_formed`."""
    return x if type(x) is int and x in (0, 1, 2) else -1


def _same(a, b) -> bool:
    """Two served numbers hold the same value (both missing counts as the same)."""
    a, b = _num(a), _num(b)
    return (math.isnan(a) and math.isnan(b)) or a == b


def _dict(x) -> dict:
    return x if isinstance(x, dict) else {}


def _check(name: str, bad_ids: list, count: int, ok_detail: str, bad_detail: str) -> dict:
    passed = not bad_ids
    return {
        "name": name,
        "passed": passed,
        "count": int(count),
        "violations": len(bad_ids),
        "detail": ok_detail if passed else f"{bad_detail}: {len(bad_ids)} (e.g. {bad_ids[:10]})",
    }


REBUILD = "rebuild: uv run python -m triage.build_events"


def audit(doc: dict, artifact: dict | None = None) -> dict:
    """Re-verify the safety invariants over every event of an events.json, recomputing the rules from each event's
    latest inputs (and each history CDM's), never from labels and never trusting the certificate's own verdict.

    artifact: the loaded model artifact (reports/model.joblib) or None. When given, the threshold stored in
    events.json must equal the artifact's.

    Not re-derived: the per-CDM model score. It needs the CDM's full allowed inputs and its event history as features,
    which events.json does not carry, so `demotions_below_threshold` checks the certificate's stored score against a
    threshold that `threshold_matches_model` ties to model_evidence (and to the loaded artifact, when there is one).

    Returns {"status": "PASS"|"FAIL", "checks": [{name, passed, count, violations, detail}], "counts", "cv_evidence"}.
    `count` is how many decisions the check covered. A file with no events, or whose summary disagrees with its
    events list, fails `events_complete`.
    """
    doc = _dict(doc)
    raw = doc.get("events")
    events = [_dict(e) for e in raw] if isinstance(raw, list) else []
    summary = _dict(doc.get("summary"))
    ids = [e.get("event_id") for e in events]
    tier = np.array([_tier(e.get("tier")) for e in events], dtype=int)
    baseline = np.array([_tier(e.get("baseline_tier")) for e in events], dtype=int)
    lat = [_dict(e.get("latest")) for e in events]
    sig = [_dict(x.get("sigma_r_m")) for x in lat]
    miss, pc = _arr(x.get("miss_distance_m") for x in lat), _arr(x.get("max_risk_estimate_log10") for x in lat)
    sig_c, sig_t = _arr(s.get("chaser") for s in sig), _arr(s.get("target") for s in sig)
    ttca, speed = _arr(x.get("time_to_tca_days") for x in lat), _arr(x.get("relative_speed_ms") for x in lat)
    pos_bad = np.array(
        [
            not (isinstance(p, list) and len(p) == 3 and all(math.isfinite(_num(v)) for v in p))
            for p in (x.get("relative_position_rtn_m") for x in lat)
        ],
        dtype=bool,
    )
    unknown_type = np.array([x.get("object_type") not in CATEGORIES["c_object_type"] for x in lat], dtype=bool)

    pc_t, miss_t = pc_tier(pc), miss_tier(miss)
    missing = np.isnan(pc) | np.isnan(miss)
    rule = np.maximum(np.maximum(pc_t, miss_t), np.where(missing, Tier.ELEVATED, Tier.SAFE))
    placeholder = (sig_c > SIGMA_SENTINEL_M) | (sig_t > SIGMA_SENTINEL_M)
    # Same rows as triage.model.input_flags (plus the sigma placeholder): never below the rule tier.
    unusable = (
        placeholder
        | np.isnan(sig_c)
        | np.isnan(sig_t)
        | (sig_c <= 0)
        | (sig_t <= 0)
        | np.isnan(ttca)
        | (ttca < 0)
        | np.isnan(speed)
        | pos_bad
        | unknown_type
        | missing
    )
    by_rule_critical = (pc_t == Tier.CRITICAL) | (miss_t == Tier.CRITICAL)
    demoted = tier < rule
    certs = [e.get("certificate") for e in events]

    def bad(mask) -> list:
        return [ids[i] for i in np.flatnonzero(mask)]

    def cert_ok(i: int) -> bool:
        c = certs[i]
        if not isinstance(c, dict):
            return False
        inv = _dict(c.get("invariants"))
        decision_ok = (
            c.get("decision") == ("demoted" if demoted[i] else "kept")
            if c.get("candidate") is True
            else c.get("decision") == "not eligible" and not demoted[i]
        )
        return (
            tier[i] >= 0
            and _tier(c.get("tier")) == tier[i]
            and _tier(c.get("rule_tier")) == rule[i]
            and decision_ok
            and set(inv) == set(INVARIANTS)
            and all(v is True for v in inv.values())
            and c.get("holds") is True
        )

    def demotion_ok(i: int) -> bool:
        c = _dict(certs[i])
        s, t = _num(c.get("model_score")), _num(c.get("threshold"))
        return c.get("candidate") is True and not unusable[i] and math.isfinite(s) and math.isfinite(t) and s < t

    # History: every CDM decision in each event's track, oldest first; the last one is the latest CDM.
    hists = [e.get("history") if isinstance(e.get("history"), list) else [] for e in events]
    hist = [(ids[i], _dict(h)) for i, hl in enumerate(hists) for h in hl]
    h_tier = np.array([_tier(h.get("pred_tier")) for _, h in hist], dtype=int)
    h_pc = _arr(h.get("max_risk_estimate_log10") for _, h in hist)
    h_miss = _arr(h.get("miss_distance_m") for _, h in hist)
    h_pc_t, h_miss_t = pc_tier(h_pc), miss_tier(h_miss)
    h_floor = np.maximum(h_miss_t, np.where(np.isnan(h_pc) | np.isnan(h_miss), Tier.ELEVATED, Tier.SAFE))
    h_crit = (h_pc_t == Tier.CRITICAL) | (h_miss_t == Tier.CRITICAL)
    h_bad = (h_tier < h_floor) | (h_crit & (h_tier != Tier.CRITICAL))
    h_bad_ids = sorted({hist[i][0] for i in np.flatnonzero(h_bad)}, key=str)

    def latest_ok(i: int) -> bool:
        if not hists[i]:
            return False
        h, x = _dict(hists[i][-1]), lat[i]
        hs = _dict(h.get("sigma_r_m"))
        return (
            all(_same(h.get(k), x.get(k)) for k in ("time_to_tca_days", "miss_distance_m", "max_risk_estimate_log10"))
            and {"chaser", "target"} <= set(hs)
            and all(_same(hs[k], sig[i].get(k)) for k in ("chaser", "target"))
            and _tier(h.get("pred_tier")) == tier[i]
            and _tier(h.get("baseline_tier")) == baseline[i]
        )

    def tiers_ok(i: int) -> bool:
        c = certs[i]
        values = [events[i].get("tier"), events[i].get("baseline_tier")]
        values += [_dict(h).get(k) for h in hists[i] for k in ("pred_tier", "baseline_tier")]
        values += [c.get("tier"), c.get("rule_tier")] if isinstance(c, dict) else []
        return all(_tier(v) >= 0 for v in values)

    # Threshold: one model behind every certificate, the one events.json says it was built with (and the loaded one).
    evidence = doc.get("model_evidence") if isinstance(doc.get("model_evidence"), dict) else None
    ev_t = _num(evidence.get("threshold")) if evidence else math.nan
    art_t = float(artifact["threshold"]) if artifact else None
    cert_t = [
        (ids[i], c["threshold"]) for i, c in enumerate(certs) if isinstance(c, dict) and c.get("threshold") is not None
    ]
    t_bad = [eid for eid, t in cert_t if not (math.isfinite(_num(t)) and _same(t, ev_t))]
    if art_t is not None and evidence is not None and not _same(ev_t, art_t):
        t_bad.append(f"model_evidence.threshold {ev_t!r} != reports/model.joblib threshold {art_t!r}")

    n = len(events)
    n_dem = int(demoted.sum())
    by_tier = {TIER_NAMES[t]: int((tier == t).sum()) for t in Tier}
    incomplete = []
    if n == 0:
        incomplete.append("events list is empty or missing")
    if not (type(summary.get("n_events")) is int and summary["n_events"] == n):
        incomplete.append(f"summary.n_events is {summary.get('n_events')!r} but {n} events are listed")
    stated = summary.get("by_tier")
    if not (isinstance(stated, dict) and all(type(v) is int for v in stated.values()) and stated == by_tier):
        incomplete.append(f"summary.by_tier is {stated!r} but the events list gives {by_tier}")
    if len({str(i) for i in ids}) != n:
        incomplete.append("duplicate event_id")
    checks = [
        _check(
            "events_complete",
            incomplete,
            n,
            f"{n} events listed, matching summary.n_events and summary.by_tier",
            "events list empty or disagrees with its summary (a deleted event or an empty file)",
        ),
        _check(
            "tiers_well_formed",
            [ids[i] for i in range(n) if not tiers_ok(i)],
            n,
            "every tier, baseline tier, history tier and certificate tier is an integer 0, 1 or 2",
            "events with a tier that is not an integer 0, 1 or 2",
        ),
        _check(
            "critical_by_rule_stays_critical",
            bad(by_rule_critical & (tier != Tier.CRITICAL)),
            by_rule_critical.sum(),
            f"all {int(by_rule_critical.sum())} events Critical by rule (Pc bound >= 1e-4 or miss < 1 km) are Critical",
            "events Critical by rule but shown below Critical",
        ),
        _check(
            "not_below_miss_rule",
            bad(tier < miss_t),
            n,
            f"no event's tier is below its miss-distance tier ({n} events)",
            "events below their miss-distance tier",
        ),
        _check(
            "unusable_uncertainty_not_demoted",
            bad(unusable & demoted),
            unusable.sum(),
            f"none of the {int(unusable.sum())} events with placeholder, missing or non-positive sigma, unknown object "
            "type, missing or negative time to TCA, missing relative speed / position, or missing Pc bound / miss "
            "distance is below its rule tier",
            "events with unusable or missing input demoted below the rule tier",
        ),
        _check(
            "demotions_below_threshold",
            [ids[i] for i in np.flatnonzero(demoted) if not demotion_ok(i)],
            n_dem,
            f"all {n_dem} demotions are eligible CDMs whose stored model score is below the threshold (the score "
            "itself is not re-derived: events.json lacks each CDM's full inputs and history features)",
            "demotions without an eligible certificate whose score is below the threshold",
        ),
        _check(
            "threshold_matches_model",
            t_bad,
            len(cert_t),
            f"all {len(cert_t)} certificate thresholds equal model_evidence.threshold"
            + (
                " and the loaded reports/model.joblib threshold" if art_t is not None else " (no model artifact loaded)"
            ),
            "certificate thresholds that differ from model_evidence.threshold or the loaded model",
        ),
        _check(
            "model_only_demotes",
            bad(tier > rule) + bad(baseline != np.maximum(pc_t, miss_t)),
            n,
            "every tier is at or below its rule tier, and every baseline_tier matches the rules",
            "events above their rule tier or with a baseline_tier that does not match the rules",
        ),
        _check(
            "certificates_consistent",
            [ids[i] for i in range(n) if not cert_ok(i)],
            n,
            f"all {n} certificates match the served tier, the recomputed rule tier and the decision, "
            "and say holds with every invariant true",
            f"events whose certificate is missing or disagrees with the tier ({REBUILD})",
        ),
        _check(
            "latest_matches_history",
            [ids[i] for i in range(n) if not latest_ok(i)],
            n,
            "every event's latest inputs (time to TCA, miss distance, Pc bound, sigma) and tiers equal its last "
            "history CDM",
            f"events whose latest CDM differs from the last CDM in their history ({REBUILD})",
        ),
        _check(
            "every_cdm_respects_rule_floor",
            h_bad_ids,
            len(hist),
            f"all {len(hist)} CDM decisions in event histories are at or above the miss-distance tier, at least "
            "Elevated when the Pc bound or miss distance is missing, and Critical whenever a rule says Critical",
            "events with a history CDM below the rule floor",
        ),
    ]
    decisions = [c.get("decision") if isinstance(c, dict) else "missing" for c in certs]
    counts = {"events": n, "cdm_decisions": len(hist)} | {
        d.replace(" ", "_"): decisions.count(d) for d in (*DECISIONS, "missing")
    }
    return {
        "status": "PASS" if all(c["passed"] for c in checks) else "FAIL",
        "checks": checks,
        "counts": counts,
        "cv_evidence": cv_evidence(evidence, certs, art_t),
    }


EVIDENCE_SOURCE = "read from events.json (copied from the artifact at build time)"


def cv_evidence(evidence: dict | None, certs: list, artifact_threshold: float | None = None) -> dict:
    """The model's held-out recall evidence, read from events.json (copied from the artifact at build time).

    Only the threshold is compared with the loaded artifact; the CV numbers are reported as stored, not recomputed.
    """
    if not evidence or not evidence.get("cv"):
        return {
            "available": False,
            "source": EVIDENCE_SOURCE,
            "detail": "events.json carries no stored CV evidence (built with the rules alone, or before this "
            "field existed); no numbers are reported",
        }
    cv = evidence["cv"]
    thresholds = {c.get("threshold") for c in certs if isinstance(c, dict) and c.get("threshold") is not None}
    return {
        "available": True,
        "source": EVIDENCE_SOURCE,
        "artifact": evidence.get("source"),
        "oof_recall": cv.get("oof_recall"),
        "recall_target": cv.get("recall_target"),
        "threshold": evidence.get("threshold"),
        "candidates": cv.get("candidates"),
        "n_folds": cv.get("n_folds"),
        "threshold_matches_certificates": thresholds <= {evidence.get("threshold")},
        "threshold_matches_loaded_model": None
        if artifact_threshold is None
        else _same(evidence.get("threshold"), artifact_threshold),
        "detail": "Out-of-fold recall of truly-Elevated demotion candidates over event-grouped CV folds, as stored "
        "in the model artifact and copied into events.json at build time (not recomputed here); the threshold is "
        "that score quantile",
    }


def model_evidence(artifact: dict | None) -> dict | None:
    """What events.json records about the model behind its certificates: real stored artifact values only."""
    if not artifact:
        return None
    cv = artifact.get("cv") or {}
    keep = ("oof_recall", "recall_target", "threshold", "candidates", "n_folds", "oof_false_elevated_removed")
    return {
        "source": "reports/model.joblib (triage.train), copied at build time",
        "threshold": float(artifact["threshold"]),
        "cv": {k: cv[k] for k in keep if k in cv},
    }
