# Contracts between the four workstreams

Change these only in a PR that updates every consumer, plus `tests/test_triage.py`.

## 1. `triage.model.predict(df) -> DataFrame` (owner: B)
Input: CDM rows from `triage.data.load_cdms` (allowed features only). Output indexed like `df`:

| column | type | meaning |
|---|---|---|
| `pred_tier` | int | 0 below threshold · 1 Elevated · 2 Critical |
| `confidence` | float 0–1 | model confidence in `pred_tier` |
| `needs_review` | bool | uncertain → shown as "needs review"; uncertainty only ever escalates. On a kept demotion candidate it marks a **close call** just above the demotion bar: mostly over-warnings (2.0% truly Elevated on train CV, vs 32.1% for other kept candidates), not the riskiest rows, so it is shown as "close call: near the demotion bar, likely over-warning; analyst can clear". Also set for missing/unknown input (NaN Pc upper bound, miss or sigma; unknown `c_object_type`): never demoted, and NaN Pc/miss is at least Elevated. Malformed files raise `ValueError` (see docs/robustness.md) |

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
    "history": [{"time_to_tca_days": 5.5, "miss_distance_m": 900.0, "max_risk_estimate_log10": -4.1,
                 "sigma_r_m": {"chaser": 48.0, "target": 5.1}, "risk_log10": -4.4, "pred_tier": 2,
                 "baseline_tier": 2}]
  }]
}
```
- Events sorted most urgent first (tier desc, then soonest TCA).
- Display-only context (never model inputs; not in the challenge's allowed-feature list): `latest.geocentric_latitude_deg` (latitude of the conjunction point), `latest.target_altitude_km` = [perigee, apogee] of our satellite, and `summary.by_latitude_band` (events and Criticals per 30° band). All `null` when the input file lacks those columns. There is no longitude in the data, so a globe can show a latitude band, not a point.
- `summary.critical_drivers` = `{miss_only, pc_only, both}`: which rule makes each Critical event Critical at its latest CDM (miss < 1 km, Pc upper bound >= 1e-4, or both). Sums to `by_tier.Critical`.
- `baseline_tier` = the conservative rule (worse of the `max_risk_estimate` tier and the miss tier) the model improves on; `summary.by_baseline_tier` counts it. The model only ever demotes, so `tier <= baseline_tier`.
- `true_tier` / `risk_log10` are `null` when the file has no labels (live use). Show them only in the evaluation view.
- `cautions` (from `triage.explain.cautions`, latest CDM): `needs_review` (as above; `triage.explain.review_kind` says
  whether it is a `close_call` or an unusable `input`) · `no_covariance` (a sigma is the
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
- `certificate` (from `triage.certify.certify`, latest CDM): why the tier holds. See §6. Top-level `model_evidence`
  = `{"source", "threshold", "cv": {oof_recall, recall_target, threshold, candidates, n_folds, ...}}` copied from the
  trained artifact at build time, or `null` when built with the rules alone.
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
| `GET /api/audit` | §6: re-verifies the safety invariants over every served event; `{"status": "PASS"\|"FAIL", "checks", "counts", "cv_evidence", "generated_at_source": "reports"\|"demo"}` |
| `POST /api/triage` | §6: tiers 1-500 CDM rows sent as JSON, each with its certificate and margin to the next tier; `422` on bad input |
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

## 6. Assured triage: certificates, `GET /api/audit`, `POST /api/triage` (owner: Model & API, `triage/certify.py`)
"Second Look can never hide a Critical" is checkable per decision. Nothing here reads `risk` or `true_tier`, and nothing
here changes a tier: certificates describe the decision `triage.model.predict` already made.

**Certificate** (one per CDM decision: `triage.model.predict_with_certificates(df)` adds a `certificate` column next to
`predict()`'s unchanged columns; `events.json` carries one per event, for its latest CDM):
```json
{"tier": 0, "tier_name": "Below threshold", "rule_tier": 1, "rule_tier_name": "Elevated",
 "rules_fired": ["pc_bound in [1e-6, 1e-4)"], "candidate": true, "why_not_candidate": null, "input_flags": [],
 "model": "trained", "model_score": 0.0068, "threshold": 0.0083, "recall_target": 0.99, "decision": "demoted",
 "invariants": {"never_demotes_critical": true, "not_below_miss_rule": true,
                "unusable_uncertainty_not_demoted": true, "demotion_below_threshold": true}, "holds": true}
```
- `rule_tier`: worse of the Pc-upper-bound tier and the miss tier, at least Elevated if either input is missing.
- `candidate`: the model may act (Elevated purely by the Pc upper bound, miss > 5 km, usable covariance, complete
  and valid inputs, known object type). Otherwise `why_not_candidate` is one of `Critical`, `Elevated by miss
  distance`, `below threshold by rule (nothing to remove)`, `sigma placeholder (no usable covariance)`, `missing input
  (<columns>)`, `invalid input (c_sigma_r <= 0 | t_sigma_r <= 0 | time_to_tca < 0 (after TCA))`, `unknown object
  type`. `model_score` / `threshold` are set only for candidates scored by a trained model.
- `input_flags` (= `triage.model.input_flags`, plus the sigma placeholder): `<column> missing` for a null Pc bound,
  miss distance, sigma, time to TCA, relative speed or relative position; `c_sigma_r <= 0` / `t_sigma_r <= 0`;
  `time_to_tca < 0 (after TCA)`; `unknown object type`; `sigma placeholder`. A flagged CDM is never below its rule
  tier and is `needs_review`. Not flagged: null `F10` / `AP` (space weather, often blank in the real data; the model
  handles a missing value there natively).
- `decision`: `demoted` (candidate, tier below rule tier) · `kept` (candidate, rule tier kept) · `not eligible`.
- `invariants`: Critical by rule stays Critical · tier never below the miss tier · a CDM with any `input_flags` never
  below the rule tier · every tier below the rule tier is a candidate with `model_score < threshold`. `holds` = all
  four.

**`GET /api/audit`** recomputes the rules from each served event's `latest` inputs (and each `history` CDM) and checks,
without trusting the certificates' own verdicts; every check below is a FAIL condition:
- `events_complete`: at least one event; `summary.n_events` and `summary.by_tier` equal the counts recomputed from the
  events list; no duplicate `event_id` (catches a deleted event and an empty file).
- `tiers_well_formed`: every event, baseline, history and certificate tier is an integer 0, 1 or 2 (`2.5`, `2.0`,
  `"2"`, `true`, `null` fail).
- `critical_by_rule_stays_critical`, `not_below_miss_rule`, `unusable_uncertainty_not_demoted` (the `input_flags`
  conditions above, recomputed from `latest`).
- `demotions_below_threshold`: every demotion is an eligible candidate whose certificate score is below its threshold.
- `threshold_matches_model`: every certificate threshold equals `model_evidence.threshold`, which must equal the
  loaded `reports/model.joblib` threshold when that file exists.
- `model_only_demotes` (tier <= rule tier, `baseline_tier` matches the rules), `certificates_consistent` (each event
  has a certificate matching its tier, rule tier and decision, with `holds: true` and all four invariants true).
- `latest_matches_history`: `latest` time to TCA, miss distance, Pc bound and sigma, and the event's tier and
  baseline tier, equal its last `history` CDM.
- `every_cdm_respects_rule_floor`: each history CDM is at or above its miss tier, at least Elevated when its Pc bound
  or miss distance is null, and Critical whenever a rule says Critical.

What the audit cannot re-derive: the per-CDM model score. It needs each CDM's full allowed inputs and its event-history
features, which `events.json` does not carry, so the audit checks the stored score against a threshold it ties to
`model_evidence` and the loaded artifact. Each check is `{"name", "passed", "count" (decisions covered), "violations",
"detail"}` and a failing `detail` lists example event ids. `counts` = `{events, cdm_decisions, kept, demoted,
not_eligible, missing}`. `cv_evidence` has `"source": "read from events.json (copied from the artifact at build
time)"` and the stored values only (`oof_recall`, `recall_target`, `threshold`, `candidates`, `n_folds`; not
recomputed), plus `threshold_matches_loaded_model` (`null` when no artifact is loaded), or `{"available": false}`.
The result is cached per `events.json` file version (about 60 ms cold on the full test set, about 1 ms after).

**`POST /api/triage`** body `{"cdms": [{<every allowed column>, "event_id"?: int >= 0}]}`, 1-500 rows, at most
1,000,000 bytes (`413` above that, checked while the body streams in; the row cap is checked before any row is
validated). Same pipeline as `python -m triage.predict` (`triage.predict.predict_frame`), so the tiers match
`predict_file` exactly. Rows sharing an `event_id` form one event (history features); a row without one is its own
one-CDM event (internal negative id, which is why a sent id must be >= 0). Every allowed column must be present;
`null` means unknown, and so does a non-finite number (`Infinity`, `-Infinity`, `NaN`; listed in
`non_finite_as_missing`; `predict_file` reads a CSV `inf` the same way). Unknown or invalid input follows the
`input_flags` rules above: null Pc / miss -> at least Elevated; any flagged input -> never below the rule tier and
`needs_review`; null `F10` / `AP` is passed to the model unflagged. Other keys, `risk` included, are ignored and listed
in `ignored_columns`. `422` with a plain message for a body that is not `{"cdms": [...]}`, a missing column, a
non-number, a non-string object type, an `event_id` that is not an integer from 0 to 2^63-1, or a row count outside
1-500. Response:
```json
{"n": 1, "model": "trained"|"rules only", "all_invariants_hold": true, "ignored_columns": [], "non_finite_as_missing": [],
 "results": [{"row": 0, "event_id": null, "tier": 1, "tier_name": "Elevated", "baseline_tier": 1, "confidence": 0.8,
   "needs_review": false, "reasons": ["Pc 10^-5.10 in [1e-6, 1e-4) (elevated band)", "miss distance 1.43 km within 1-5 km"],
   "certificate": {"...": "as above"},
   "to_escalate": {"next_tier": "Critical", "miss_must_drop_below_m": 1000.0, "miss_now_m": 1430.0,
                   "pc_bound_must_reach_log10": -4.0, "pc_bound_now_log10": -5.1, "miss_drop_needed_m": 430.0,
                   "pc_bound_rise_needed_decades": 1.1, "any_of": ["miss distance drops below 1,000 m (now 1,430 m)",
                   "Pc upper bound reaches 1e-4 (now 1e-5.1)"]}}]}
```
`to_escalate` is the margin to the next tier up: for Elevated, the Critical lines (miss < 1 km or Pc bound >= 1e-4);
for below threshold by rule, the Elevated lines (`miss_must_drop_to_m: 5000`, inclusive, or Pc bound >= 1e-6); for a
demotion, the miss line plus `model_score_must_reach` / `model_score_now` (its Pc bound is already in the Elevated
band); `next_tier: null` for Critical. It describes thresholds, never a manoeuvre.
