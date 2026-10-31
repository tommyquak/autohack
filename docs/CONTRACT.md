# Contracts between the four workstreams

Change these only in a PR that updates every consumer, plus `tests/test_triage.py`.

## 1. `triage.model.predict(df) -> DataFrame` (owner: B)
Input: CDM rows from `triage.data.load_cdms` (allowed features only). Output indexed like `df`:

| column | type | meaning |
|---|---|---|
| `pred_tier` | int | 0 below threshold · 1 Elevated · 2 Critical |
| `confidence` | float 0–1 | model confidence in `pred_tier` |
| `needs_review` | bool | uncertain → shown as "needs review"; uncertainty only ever escalates. Also set for missing/unknown input (NaN Pc upper bound, miss or sigma; unknown `c_object_type`): never demoted, and NaN Pc/miss is at least Elevated. Malformed files raise `ValueError` (see docs/robustness.md) |

## 2. `reports/events.json` (producer: `triage.build_events`, consumer: API + dashboard)
```json
{
  "summary": {
    "n_events": 2167,
    "by_tier": {"Below threshold": 1900, "Elevated": 220, "Critical": 47},
    "needs_review": 31,
    "cautions": {"needs_review": 31, "no_covariance": 63, "pc_diluted": 25},
    "by_action": {"MANEUVER PLANNING": 47, "ANALYST REVIEW": 300, "MONITOR": 1820}, "escalation_watch": 60,
    "warnings_24h": {"window_days": 1.0, "events_in_window": 80,
                     "within_dangerous_distance": 3, "critical_in_window": 5}
  },
  "events": [{
    "event_id": 123, "tier": 2, "tier_name": "Critical", "baseline_tier": 2, "confidence": 0.8, "needs_review": false,
    "reasons": ["Pc 10^-3.20 >= 1e-4 (critical threshold)"], "cautions": ["needs_review"],
    "action": {"queue": "MANEUVER PLANNING", "escalation_watch": false,
               "reasons": ["Critical: miss distance 640 m is under 1 km", "Queued so an analyst can start planning; ..."]},
    "latest": {"time_to_tca_days": 0.6, "miss_distance_m": 640.0, "relative_speed_ms": 12000.0,
               "relative_position_rtn_m": [12.0, -480.0, 420.0],
               "sigma_r_m": {"chaser": 48.0, "target": 5.1},
               "max_risk_estimate_log10": -3.2, "object_type": "DEBRIS"},
    "true_tier": 2,
    "history": [{"time_to_tca_days": 5.5, "miss_distance_m": 900.0,
                 "max_risk_estimate_log10": -4.1, "risk_log10": -4.4, "pred_tier": 2, "baseline_tier": 2}]
  }]
}
```
- Events sorted most urgent first (tier desc, then soonest TCA).
- Display-only context (never model inputs; not in the challenge's allowed-feature list): `latest.geocentric_latitude_deg` (latitude of the conjunction point), `latest.target_altitude_km` = [perigee, apogee] of our satellite, and `summary.by_latitude_band` (events and Criticals per 30° band). All `null` when the input file lacks those columns. There is no longitude in the data, so a globe can show a latitude band, not a point.
- `summary.critical_drivers` = `{miss_only, pc_only, both}`: which rule makes each Critical event Critical at its latest CDM (miss < 1 km, Pc upper bound >= 1e-4, or both). Sums to `by_tier.Critical`.
- `baseline_tier` = the conservative rule (worse of the `max_risk_estimate` tier and the miss tier) the model improves on; `summary.by_baseline_tier` counts it. The model only ever demotes, so `tier <= baseline_tier`.
- `true_tier` / `risk_log10` are `null` when the file has no labels (live use). Show them only in the evaluation view.
- `cautions` (from `triage.explain.cautions`, latest CDM): `needs_review` (as above) · `no_covariance` (a sigma is the
  dataset's 63,781 km placeholder, so Pc can't be trusted alone) · `pc_diluted` (combined radial sigma > miss/√2 while
  Pc < 1e-4: a low Pc may reflect poor tracking, not separation). Show them as badges; never color alone.
- `action` (from `triage.actions.action`, reads only the fields above, never `true_tier` / `risk_log10`): which queue
  the event goes to next. `queue` is exactly one of `MANEUVER PLANNING` (current tier Critical: an analyst should start
  planning; the operator decides) · `ANALYST REVIEW` (Elevated, `needs_review`, `no_covariance`, `pc_diluted`, or a
  below-threshold event with `escalation_watch`) · `MONITOR` (below threshold, no caution, no trend flag: keep watching,
  not "no risk"). `escalation_watch` = near the next threshold up and closing / not settled / just above it, with
  >= 1 day to TCA. `reasons` are plain English. `summary.by_action` counts queues (sums to `n_events`) and
  `summary.escalation_watch` counts flags. Rules and train-protocol results: `docs/actions.md`. An optional `forecast`
  object (Kalent's planned contract, `docs/algorithm/algorithm.md` §4.1) can only raise the queue.
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

## 4. HTTP API (owner: Model & API, `server.py`; consumer: dashboard)
All read `reports/*.json` (falling back to the frozen full-test-set copy in `data/demo/` when `reports/` has none, so teammates without the raw data still get real numbers) and pick up a rebuilt file without a server restart. A missing report → `503` with the command that builds it.

| route | returns |
|---|---|
| `GET /api/summary` | `events.json` → `summary` |
| `GET /api/events[?tier=0\|1\|2][&needs_review=true\|false]` | `{"total": n, "events": [...]}`: each event as in §2 **without `history`** (so with `action`), plus `n_updates` (number of CDMs). Same urgency order. |
| `GET /api/events/{event_id}` | one event exactly as in §2, with `history`; `404` if unknown |
| `GET /api/metrics` | `metrics.json` as in §3 |
| `GET /api/explain/{event_id}` | see `triage/explain.py` (owner: Integration & trust) |
| `GET /health` | `{"llm": "claude"\|"fallback", "reports": "reports"\|"demo"\|"missing", "model": "<id>", "last_answer": "claude"\|"fallback"\|null}` |

Report loading lives in `triage/reports.py` (shared by `server.py` and the copilot tools in `tools.py`).

## 5. Operator copilot (`POST /chat`, NDJSON)
Events: `{"type":"session"}`, then `{"type":"source","source":"claude"|"fallback"[,"reason"]}`, then `text` / `thinking` /
`tool_call` / `tool_result` / `error`, then `{"type":"done"}`. A `tool_call` named `focus_event` with
`input.event_id` is the event the dashboard should select. Claude answers through the read-only triage tools in
`tools.py` (get_summary, list_events, get_event, get_metrics, explain_event, compare_events, focus_event). The
deterministic router in `fallback.py` (same tools, same event types) answers when there are no usable credentials or
the Claude call fails before any text; a second `source` event then says `fallback`. The fallback also emits a
`tool_call` + `tool_result` pair for every data tool it calls, before its text, so every number has visible
provenance. "Usable credentials" (`triage.explain._has_credentials`, also behind `/health` `llm`) means a non-placeholder
`ANTHROPIC_API_KEY`, an `ANTHROPIC_AUTH_TOKEN`, or an SDK profile / workload-identity config; an unset or empty key
alone means `fallback`. `list_events` also filters by `caution` (`needs_review` / `no_covariance` / `pc_diluted`).

Pages: `/` serves `static/dashboard.html` (placeholder until it exists); other dashboard files are served under `/static/` (e.g. `/static/dashboard.js`). The agent chat moved to `/chat`.
