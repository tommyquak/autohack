"""Event action queue: what an analyst should do with an event next (the decision part of Kalent's Framework A,
docs/algorithm/algorithm.md §3, without his ML forecast).

    action(event) -> {"queue": "MANEUVER PLANNING" | "ANALYST REVIEW" | "MONITOR",
                      "reasons": [plain-English strings], "escalation_watch": bool}

Deterministic and trend-aware. It reads only fields already in events.json: tier, needs_review, cautions, latest.*
and history[*].miss_distance_m / max_risk_estimate_log10. It never reads `true_tier` or `risk_log10` (labels), and
`risk` never reaches it.

Rules (a queue is never lowered by a later rule):
1. Current tier Critical                                    -> MANEUVER PLANNING
2. Elevated, needs_review, no_covariance or pc_diluted      -> ANALYST REVIEW
3. Below threshold with escalation_watch                    -> ANALYST REVIEW
4. Otherwise                                                -> MONITOR (keep watching; below threshold is not "no risk")

escalation_watch (events not yet Critical, at least `min_days_left` days before TCA): the latest miss distance is
near the next threshold up (under `near_elevated_m` for a below-threshold event, the 5 km line; under
`near_critical_m` for an Elevated event, the 1 km line) AND at least one of
- very near: within `trend_free_frac` above that threshold;
- closing: miss distance fell by at least `min_shrink` over the last `min_updates` updates (and, if
  `require_pc_rising`, the Pc upper bound rose over the same updates);
- not settled: the last update moved miss distance by at least `swing` (either way).
An Elevated event with the flag stays in ANALYST REVIEW; the flag says it may become Critical. Thresholds are tuned
by event-grouped cross-validation on train only (scripts/eval_actions.py, docs/actions.md).

"MANEUVER PLANNING" means an analyst should start planning; it is not a decision. The operator decides.

Forecast hook (optional, not required): if the event carries a CALIBRATED `forecast` object (Kalent's planned
contract: {"calibrated": true, "p_final": [p_below, p_elevated, p_critical], "prediction_set": [...]}), it can only
raise the queue: Critical in the prediction set or p_critical >= `forecast_p_maneuver` -> MANEUVER PLANNING;
p_elevated + p_critical >= `forecast_p_review` -> at least ANALYST REVIEW. The shipped final-tier forecast
(triage.forecast) carries uncalibrated scores and `"calibrated": false`, so the hook ignores it: a queue never moves
on an uncalibrated score.
"""

from triage.explain import REVIEW_TEXT, review_kind
from triage.tiers import MISS_CRITICAL_M, MISS_ELEVATED_M, RISK_CRITICAL, Tier

MANEUVER = "MANEUVER PLANNING"
REVIEW = "ANALYST REVIEW"
MONITOR = "MONITOR"
QUEUES = (MANEUVER, REVIEW, MONITOR)
_RANK = {MONITOR: 0, REVIEW: 1, MANEUVER: 2}

DEFAULTS = {
    # escalation_watch, tuned by event-grouped CV on train (scripts/eval_actions.py, docs/actions.md)
    "near_elevated_m": 7_500.0,  # below threshold: "near" = latest miss distance under this (5 km threshold)
    "near_critical_m": 1_500.0,  # Elevated: "near" = latest miss distance under this (1 km threshold)
    "trend_free_frac": 0.2,  # within this fraction above the threshold, near is enough (no trend needed)
    "min_updates": 3,  # closing: compare the latest update with the one min_updates-1 updates earlier
    "min_shrink": 0.25,  # closing: miss distance fell by at least this fraction over that window
    "require_pc_rising": True,  # closing: also require the Pc upper bound to have risen over that window
    "swing": 0.2,  # unsettled: the last update moved miss distance by at least this fraction, either way
    "min_days_left": 1.0,  # policy, not tuned (no train input is < 2 days out): later, the current tier governs
    # Kalent's forecast hook: placeholders until his conformal step calibrates them
    "forecast_p_maneuver": 0.5,
    "forecast_p_review": 0.2,
}


def _km(m: float) -> str:
    return f"{m:.0f} m" if m < 10_000 else f"{m / 1000:,.1f} km"


def escalation_watch(event: dict, params: dict | None = None) -> tuple[bool, list[str]]:
    """(flag, reasons) for an event not yet Critical: near the next threshold up, with time left, and either very
    near it, closing on it, or still moving (the track has not settled)."""
    p = {**DEFAULTS, **(params or {})}
    tier = int(event["tier"])
    latest = event["latest"]
    miss, days = latest["miss_distance_m"], latest["time_to_tca_days"]
    if tier >= Tier.CRITICAL or days < p["min_days_left"]:
        return False, []
    if tier == Tier.ELEVATED:
        threshold, near_m, label = MISS_CRITICAL_M, p["near_critical_m"], "1 km (Critical)"
    else:
        threshold, near_m, label = MISS_ELEVATED_M, p["near_elevated_m"], "5 km (Elevated)"
    if not miss < near_m:
        return False, []

    hist = event.get("history") or []
    misses = [h["miss_distance_m"] for h in hist]
    pcs = [h["max_risk_estimate_log10"] for h in hist]
    signals = []
    if miss < threshold * (1 + p["trend_free_frac"]):
        signals.append(f"Miss distance {_km(miss)} is just above the {label} threshold")
    n = int(p["min_updates"])
    if len(misses) >= n and misses[-n] > 0:
        shrink = 1 - misses[-1] / misses[-n]
        if shrink >= p["min_shrink"] and (not p["require_pc_rising"] or pcs[-1] > pcs[-n]):
            signals.append(
                f"Closing over the last {n} updates: miss distance {_km(misses[-n])} -> {_km(misses[-1])}, "
                f"Pc upper bound 1e{pcs[-n]:.1f} -> 1e{pcs[-1]:.1f}"
            )
    if len(misses) >= 2 and misses[-2] > 0 and abs(misses[-1] / misses[-2] - 1) >= p["swing"]:
        signals.append(
            f"Not settled: the last update moved miss distance {_km(misses[-2])} -> {_km(misses[-1])}, "
            "so later updates may move it again"
        )
    if not signals:
        return False, []
    reasons = [f"Escalation watch: the event may cross the {label} threshold before closest approach"]
    reasons += signals
    reasons.append(f"{days:.1f} days to closest approach: later updates may raise the tier")
    return True, reasons


def _forecast(event: dict, p: dict) -> tuple[str | None, str | None]:
    """(queue floor, reason) from Kalent's forecast object, or (None, None) when absent or malformed."""
    fc = event.get("forecast")
    if not isinstance(fc, dict) or fc.get("calibrated") is not True:
        return None, None
    pset = fc.get("prediction_set") or []
    probs = fc.get("p_final")
    p_crit = p_high = None
    if isinstance(probs, list | tuple) and len(probs) == 3:
        try:
            p_crit, p_high = float(probs[2]), float(probs[1]) + float(probs[2])
        except (TypeError, ValueError):
            p_crit = p_high = None
    if "Critical" in pset or (p_crit is not None and p_crit >= p["forecast_p_maneuver"]):
        why = f"P(final Critical) {p_crit:.2f}" if p_crit is not None else "Critical in its prediction set"
        return MANEUVER, f"Forecast: event may end Critical ({why})"
    if p_high is not None and p_high >= p["forecast_p_review"]:
        return REVIEW, f"Forecast: P(final tier Elevated or worse) {p_high:.2f}"
    return None, None


def _review_reason(event: dict, codes: set[str]) -> str:
    text = REVIEW_TEXT[review_kind(event, codes) or "input"]
    return text[0].upper() + text[1:]


def action(event: dict, params: dict | None = None) -> dict:
    """Queue, plain-English reasons and escalation_watch for one events.json event."""
    p = {**DEFAULTS, **(params or {})}
    tier = int(event["tier"])
    latest = event["latest"]
    codes = set(event.get("cautions") or [])
    if event.get("needs_review"):
        codes.add("needs_review")
    watch, watch_reasons = escalation_watch(event, p)

    reasons: list[str] = []
    if tier >= Tier.CRITICAL:
        queue = MANEUVER
        if latest["miss_distance_m"] < MISS_CRITICAL_M:
            reasons.append(f"Critical: miss distance {_km(latest['miss_distance_m'])} is under 1 km")
        if latest["max_risk_estimate_log10"] >= RISK_CRITICAL:
            reasons.append(f"Critical: Pc upper bound 1e{latest['max_risk_estimate_log10']:.1f} is at or above 1e-4")
        if not reasons:
            reasons.append("Critical tier from the pipeline")
        reasons.append("Queued so an analyst can start planning; whether to act is the operator's decision")
    else:
        queue = MONITOR
        if tier == Tier.ELEVATED:
            queue = REVIEW
            reasons.append("Elevated tier: an analyst should review the event")
        if "needs_review" in codes:
            queue = REVIEW
            reasons.append(_review_reason(event, codes))
        if "no_covariance" in codes:
            queue = REVIEW
            reasons.append("No usable position uncertainty: the Pc estimate cannot be relied on by itself")
        if "pc_diluted" in codes:
            queue = REVIEW
            reasons.append("Probability dilution: a low Pc may reflect poor tracking rather than real separation")
        if watch:
            queue = REVIEW
        if queue == MONITOR:
            reasons.append(
                "Below threshold with no closing trend or caution: keep monitoring new updates "
                "(below threshold is not the same as no risk)"
            )
    if watch:
        reasons += watch_reasons

    floor, why = _forecast(event, p)
    if floor is not None and _RANK[floor] > _RANK[queue]:
        if queue == MONITOR:
            reasons = []  # drop the "keep monitoring" line
        queue = floor
    if why:
        reasons.append(why)
    return {"queue": queue, "reasons": reasons, "escalation_watch": watch}
