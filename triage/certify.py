"""Assured triage: a certificate for every decision, and a live audit of the safety invariants.

"Second Look can never hide a Critical" is a claim about every single decision. This module makes it checkable:

    certify(row, pred, artifact) -> dict   why one CDM's tier holds: rules fired, whether the model was allowed to act
                                           and why not, its score against the threshold, and four invariants
    to_escalate(row, certificate)  -> dict what would move the CDM to the next tier up (margin to each threshold)
    reasons(row, certificate)      -> list plain-English reasons, including missing input and demotion
    audit(doc)                     -> dict re-verifies the invariants over every event (and every CDM in each
                                           event's history) of an events.json, from its inputs, not from its labels

Nothing here reads `risk` (the label) or `true_tier`. Certificates describe decisions; they never change one: the tier
always comes from triage.model.predict.

Invariants (each true/false per certificate, re-checked by audit):
- never_demotes_critical            Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km) stays Critical
- not_below_miss_rule               the tier is never below the miss-distance tier
- unusable_uncertainty_not_demoted  placeholder or missing sigma, unknown object type, or missing Pc bound / miss
                                    distance: never below the rule tier
- demotion_below_threshold          any tier below the rule tier is a model demotion of an eligible CDM whose score
                                    is below the stored threshold
"""

import math
from collections.abc import Mapping

import numpy as np

from triage.data import CATEGORIES
from triage.features import SIGMA_SENTINEL_M
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
    sigma_missing = [c for c, v in (("c_sigma_r", sig_c), ("t_sigma_r", sig_t)) if math.isnan(v)]
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
    elif sigma_missing:
        why_not = f"missing input ({', '.join(sigma_missing)})"
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

    flags = [f"{c} missing" for c in (*missing, *sigma_missing)]
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


def _check(name: str, bad_ids: list, count: int, ok_detail: str, bad_detail: str) -> dict:
    passed = not bad_ids
    return {
        "name": name,
        "passed": passed,
        "count": int(count),
        "violations": len(bad_ids),
        "detail": ok_detail if passed else f"{bad_detail}: {len(bad_ids)} (e.g. {bad_ids[:10]})",
    }


def audit(doc: dict) -> dict:
    """Re-verify the safety invariants over every event of an events.json, recomputing the rules from each event's
    latest inputs (and each history CDM's), never from labels and never trusting the certificate's own verdict.

    Returns {"status": "PASS"|"FAIL", "checks": [{name, passed, count, violations, detail}], "counts", "cv_evidence"}.
    `count` is how many decisions the check covered.
    """
    events = doc.get("events") or []
    ids = [e["event_id"] for e in events]
    tier = np.array([int(e["tier"]) for e in events], dtype=int)
    lat = [e["latest"] for e in events]
    miss, pc = _arr(x["miss_distance_m"] for x in lat), _arr(x["max_risk_estimate_log10"] for x in lat)
    sig_c, sig_t = _arr(x["sigma_r_m"]["chaser"] for x in lat), _arr(x["sigma_r_m"]["target"] for x in lat)
    unknown_type = np.array([x.get("object_type") not in CATEGORIES["c_object_type"] for x in lat], dtype=bool)

    pc_t, miss_t = pc_tier(pc), miss_tier(miss)
    missing = np.isnan(pc) | np.isnan(miss)
    rule = np.maximum(np.maximum(pc_t, miss_t), np.where(missing, Tier.ELEVATED, Tier.SAFE))
    placeholder = (sig_c > SIGMA_SENTINEL_M) | (sig_t > SIGMA_SENTINEL_M)
    unusable = placeholder | np.isnan(sig_c) | np.isnan(sig_t) | unknown_type | missing
    by_rule_critical = (pc_t == Tier.CRITICAL) | (miss_t == Tier.CRITICAL)
    demoted = tier < rule
    certs = [e.get("certificate") for e in events]

    def bad(mask) -> list:
        return [ids[i] for i in np.flatnonzero(mask)]

    def cert_ok(i: int) -> bool:
        c = certs[i]
        if not isinstance(c, dict):
            return False
        decision_ok = (
            c.get("decision") == ("demoted" if demoted[i] else "kept")
            if c.get("candidate")
            else c.get("decision") == "not eligible" and not demoted[i]
        )
        return (
            c.get("tier") == tier[i]
            and c.get("rule_tier") == rule[i]
            and decision_ok
            and set(c.get("invariants") or {}) == set(INVARIANTS)
            and all((c.get("invariants") or {}).values())
        )

    def demotion_ok(i: int) -> bool:
        c = certs[i] if isinstance(certs[i], dict) else {}
        s, t = c.get("model_score"), c.get("threshold")
        return bool(c.get("candidate")) and not unusable[i] and s is not None and t is not None and s < t

    baseline = np.array([int(e.get("baseline_tier", -1)) for e in events], dtype=int)
    hist = [(e["event_id"], h) for e in events for h in e.get("history") or []]
    h_tier = np.array([int(h["pred_tier"]) for _, h in hist], dtype=int)
    h_pc_t = pc_tier(_arr(h["max_risk_estimate_log10"] for _, h in hist))
    h_miss_t = miss_tier(_arr(h["miss_distance_m"] for _, h in hist))
    h_bad = (h_tier < h_miss_t) | (
        ((h_pc_t == Tier.CRITICAL) | (h_miss_t == Tier.CRITICAL)) & (h_tier != Tier.CRITICAL)
    )
    h_bad_ids = sorted({hist[i][0] for i in np.flatnonzero(h_bad)})

    n = len(events)
    n_dem = int(demoted.sum())
    checks = [
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
            f"none of the {int(unusable.sum())} events with placeholder or missing sigma, unknown object type or "
            "missing Pc bound / miss distance is below its rule tier",
            "events with unusable or missing input demoted below the rule tier",
        ),
        _check(
            "demotions_below_threshold",
            [ids[i] for i in np.flatnonzero(demoted) if not demotion_ok(i)],
            n_dem,
            f"all {n_dem} demotions are eligible CDMs with model score < threshold",
            "demotions without an eligible certificate whose score is below the threshold",
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
            "and every invariant in them holds",
            "events whose certificate is missing or disagrees with the tier (rebuild: uv run python -m "
            "triage.build_events)",
        ),
        _check(
            "every_cdm_respects_rule_floor",
            h_bad_ids,
            len(hist),
            f"all {len(hist)} CDM decisions in event histories are at or above the miss-distance tier and Critical "
            "whenever a rule says Critical",
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
        "cv_evidence": cv_evidence(doc.get("model_evidence"), certs),
    }


def cv_evidence(evidence: dict | None, certs: list) -> dict:
    """The model's held-out recall evidence as stored in its artifact (copied into events.json at build time)."""
    if not evidence or not evidence.get("cv"):
        return {
            "available": False,
            "detail": "events.json carries no stored CV evidence (built with the rules alone, or before this "
            "field existed); no numbers are reported",
        }
    cv = evidence["cv"]
    thresholds = {c.get("threshold") for c in certs if isinstance(c, dict) and c.get("threshold") is not None}
    return {
        "available": True,
        "source": evidence.get("source"),
        "oof_recall": cv.get("oof_recall"),
        "recall_target": cv.get("recall_target"),
        "threshold": evidence.get("threshold"),
        "candidates": cv.get("candidates"),
        "n_folds": cv.get("n_folds"),
        "threshold_matches_certificates": thresholds <= {evidence.get("threshold")},
        "detail": "Out-of-fold recall of truly-Elevated demotion candidates over event-grouped CV folds, as stored "
        "in the model artifact; the threshold is that score quantile",
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
