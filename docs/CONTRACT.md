# Contracts between the four workstreams

Change these only in a PR that updates every consumer, plus `tests/test_triage.py`.

## 1. `triage.model.predict(df) -> DataFrame` (owner: B)
Input: CDM rows from `triage.data.load_cdms` (allowed features only). Output indexed like `df`:

| column | type | meaning |
|---|---|---|
| `pred_tier` | int | 0 below threshold · 1 Elevated · 2 Critical |
| `confidence` | float 0–1 | model confidence in `pred_tier` |
| `needs_review` | bool | uncertain → shown as "needs review"; uncertainty only ever escalates |

## 2. `reports/events.json` (producer: `triage.build_events`, consumer: API + dashboard)
```json
{
  "summary": {
    "n_events": 2167,
    "by_tier": {"Below threshold": 1900, "Elevated": 220, "Critical": 47},
    "needs_review": 31,
    "warnings_24h": {"window_days": 1.0, "events_in_window": 80,
                     "within_dangerous_distance": 3, "critical_in_window": 5}
  },
  "events": [{
    "event_id": 123, "tier": 2, "tier_name": "Critical", "confidence": 0.8, "needs_review": false,
    "reasons": ["Pc 10^-3.20 >= 1e-4 (critical threshold)"],
    "latest": {"time_to_tca_days": 0.6, "miss_distance_m": 640.0, "relative_speed_ms": 12000.0,
               "relative_position_rtn_m": [12.0, -480.0, 420.0],
               "sigma_r_m": {"chaser": 48.0, "target": 5.1},
               "max_risk_estimate_log10": -3.2, "object_type": "DEBRIS"},
    "true_tier": 2,
    "history": [{"time_to_tca_days": 5.5, "miss_distance_m": 900.0,
                 "max_risk_estimate_log10": -4.1, "risk_log10": -4.4, "pred_tier": 2}]
  }]
}
```
- Events sorted most urgent first (tier desc, then soonest TCA).
- `true_tier` / `risk_log10` are `null` when the file has no labels (live use). Show them only in the evaluation view.
- Wording: never "Safe" – tier 0 is **"Below threshold"**.

## 3. `reports/metrics.json` (producer: `triage.evaluate`, consumer: dashboard "Evaluation" tab)
```json
{
  "split": "test",
  "class_counts": {"SAFE": 0, "ELEVATED": 0, "CRITICAL": 0},
  "results": {"<method>": {"n": 0, "critical_recall": 0.0, "critical_precision": 0.0,
                            "false_alarm_rate": 0.0, "macro_f1": 0.0, "flagged_rate": 0.0, "under_tier_rate": 0.0, "confusion": [[0,0,0],[0,0,0],[0,0,0]]}},
  "by_lead_time": {"<method>": [{"days_to_tca": [0, 1], "...": "same fields as results"}]},
  "missed_criticals": [{"event_id": 0, "time_to_tca": 0.0, "miss_distance": 0.0,
                        "max_risk_estimate": 0.0, "risk": 0.0}]
}
```
Methods: `majority_class`, `miss_distance_rule`, `max_risk_estimate_rule` (baselines), `model`.
Confusion matrix rows = truth, columns = prediction, order Safe/Elevated/Critical.
