# Robustness: junk and edge-case input

`uv run python -m evals.robustness_eval` builds each case from `data/sample/cdm_sample.csv` in a temp dir, runs it
through `triage.predict.predict_file` (the same path as `python -m triage.predict`) and calls a few `/api` routes
through FastAPI's TestClient. Modelled on the lvl 500 HackHarvard 2026 `chalk_tools/junk_eval*.py`.

**Checked on every output row (the rule floor):** `pred_tier` is never below the miss-distance rule, is Critical
whenever `max_risk_estimate >= -4`, and is never below Elevated when Pc or miss distance is missing. The tier may drop
below `baseline_tier` in one place only: a clean demotion candidate (Elevated purely from the Pc upper bound, miss
> 5 km, usable covariance, no missing inputs). That is the trained model's job, and it is documented in
`triage/train.py`. Bad input must be rejected with a `ValueError` that names the problem, or flagged `needs_review`.

## Results (trained model; the same 26/26 with baseline rules only)

Before the fixes: **20/26**. After: **26/26**, 0 crashes. "Targets" are the 3 mutated rows.

| Case | Expected | Observed (after fixes) | Before | After |
|---|---|---|---|---|
| missing required column | reject, names column | `... is missing expected columns: ['miss_distance']` | pass | pass |
| extra unknown columns | ignored | same tiers as the clean file | pass | pass |
| labels removed (live use) | works without `risk` | same tiers | pass | pass |
| NaN miss_distance | >= Elevated + review | targets Elevated, review | **FAIL**: 1 row demoted to below threshold | pass |
| NaN max_risk_estimate | >= Elevated + review | targets Elevated, review | **FAIL**: all 3 below threshold, not flagged | pass |
| non-numeric miss_distance | reject, names column | `column 'miss_distance' has non-numeric values, e.g. 'far away' in data row 0` | **FAIL**: `could not convert string to float` (no column) | pass |
| negative miss distance | Critical | Critical | pass | pass |
| miss exactly 1000 m / 5000 m | Elevated | Elevated (boundary inclusive) | pass | pass |
| max_risk_estimate exactly -4 | Critical | Critical | pass | pass |
| max_risk_estimate exactly -6 | baseline Elevated | baseline Elevated; **model demotes to below threshold** (see limits) | pass | pass |
| risk floor -30 | below threshold | below threshold | pass | pass |
| placeholder sigma 63,781,360 m | never demoted, review | Elevated, review (trained model); review was missing in baseline-only mode | pass* | pass |
| NaN c_sigma_r | never demoted, review | Elevated, review | **FAIL**: demoted, not flagged | pass |
| unknown c_object_type (`ALIEN SHIP`) | review, never demoted | Elevated, review | **FAIL**: 1 row demoted, not flagged | pass |
| huge / infinite values | no crash | Critical where `max_risk_estimate` = 1e6 | pass | pass |
| single-CDM event | tiered | tiered (history features empty) | pass | pass |
| shuffled row order | identical per-row output | identical | pass | pass |
| duplicated rows | no crash, floor holds | floor holds (history features see repeats) | pass | pass |
| time_to_tca < 1 day | no crash, floor holds | floor holds | pass | pass |
| header only (0 rows) | 0 rows out | 0 rows | pass | pass |
| empty file (0 bytes) | reject, says empty | `... is empty - expected a CSV header with columns [...]` | **FAIL**: `No columns to parse from file` | pass |
| `GET /api/events/999999` | 404 + message | `404: event 999999 not in reports/events.json` | pass | pass |
| `GET /api/events/abc` | 422 + message | `422: Input should be a valid integer` | pass | pass |
| `GET /api/events?tier=abc` | 422 | 422 | pass | pass |
| `GET /api/explain/999999` | 404 | 404 | pass | pass |

\* passed with the trained model. In baseline-only mode (no `reports/model.joblib`) it failed, because the baseline
never set `needs_review` for diluted covariance.

## Fixes

1. **NaN Pc upper bound or miss distance came out below threshold.** NaN fails every `>=` / `<` comparison, so both
   rules returned tier 0. `triage.model.predict` now treats NaN `max_risk_estimate` or `miss_distance` as at least
   Elevated with `needs_review`, and `predict_file` reports `baseline_tier` >= Elevated for those rows.
2. **NaN sigma or an unknown object type could be demoted.** Those rows are now never demoted below the rule tier
   and are flagged `needs_review` (`triage.model.input_flags`). Unseen `c_object_type` labels become missing on
   purpose; this also removes a pandas 4 deprecation warning.
3. **Malformed files gave pandas errors.** `triage.data.read_cdm_csv`, shared by `load_cdms` and `predict_file`,
   raises a `ValueError` naming the file and the problem: empty file, missing columns, a non-numeric value (column,
   value and row), or a blank `event_id`.
4. **Baseline-only mode did not flag diluted covariance.** It now sets `needs_review` like the trained path.

Regression tests: `tests/test_robustness.py`. On the real test set the only change is 6 CDMs with NaN `c_sigma_r`
(events 276, 1062, 1563), which are now `needs_review`. No tier changed. `predictions/test_predictions.csv` is
regenerated. The frozen `data/demo/events.json` is not.

## Remaining limits

- **The model can return a tier below the rule baseline.** The case above with `max_risk_estimate` exactly -6 (miss
  50 km) is demoted to below threshold, by design: removing over-warnings from the Pc upper bound is what the model is
  for. The guarantee is statistical, not per CDM: about 99% recall on held-out events (`train.py`). An operator who
  needs "never below the rule" should read `baseline_tier`, which is always in the output.
- **Physically impossible values are tiered, not rejected.** A negative miss distance comes out Critical (miss < 1 km
  rule). `max_risk_estimate` > 0 (Pc > 1) also comes out Critical. Negative `time_to_tca` and negative sigmas are
  accepted. These rows are never under-tiered, but nothing flags them as bad data.
- **No physics checks** on speed, position or F10/AP ranges. NaN F10/AP is normal in the dataset and is not flagged.
- **Duplicated CDMs change the history features**, so `needs_review` can differ from the de-duplicated file. Tiers
  still respect the rule floor.
- **The API does not validate range:** `GET /api/events?tier=7` returns an empty list instead of a 422.
- **Coverage:** these are hand-built cases on a 1,764-row sample, not fuzzing.
