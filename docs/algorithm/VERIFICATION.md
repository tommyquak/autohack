# Verification of algorithm.md, feature.md and baseline.py

Checked 31 Oct 2026, against the README problem statement (the "Challenge track" section as of `53cd7a8`, the
source of truth; `main`'s README has since been rewritten as the judge-facing write-up, which agrees that `risk` is
label-only and that the 24 h panel is empty on test),
`docs/CONTRACT.md`, `docs/PLAN.md`, `docs/TEAM.md`, `data/README.md`, `docs/HANDOVER.md`, `docs/ALGO.md` and the
`triage/` code on `origin/main` at `4d297d1`. That commit has PR #3 (model) merged, plus the API, explain and
`cautions` PRs. The resolution of the `risk`-as-input question is in §g.

**Bottom line**
- Every dataset number and every baseline number reproduces, **except the plain LightGBM row** (small drift, §c).
- The 908 / 895 / 13 claim is correct. The 13 split into 3 that are Critical from Pc alone and 10 that are Critical
  from both rules.
- The biggest problem is a rules conflict, not a numbers problem. Our docs use `risk` from the CDMs at 2 days or more
  as a model input (persistence, T₀, five risk features). The README's column list leaves `risk` out, and every team
  doc treats it as label-only. A risk-free persistence baseline (miss distance only) scores **as well or better**:
  acc 0.935, F2 0.818, 0/244 escalations. So the forecasting story survives the fix at no cost (§b row 1).
- `test_data.csv` **does** have per-CDM labels (`risk` is 100% filled). It only lacks final (< 2 d) CDMs. The team
  already scores the per-CDM model on test, as the README requires. Our docs say test has "no labels" (§b row 3).

Data files used (not in git, `data/raw/` is gitignored). Teammates can check they have the same files:

| file | size | sha256 |
|---|---|---|
| `train_data.csv` | 233,600,296 B | `ba47ce80580d5d6ff523ddc1d724901dbdfb3a5afdc5e755f0ca2bcefe6e4eb6` |
| `test_data.csv` | 35,303,060 B | `fc4110e979e7d569cb8aa819d450d29311e799115b2fe5b519b8a18eafa37323` |

The only data in GitHub is `data/sample/cdm_sample.csv`, identical on `main`, `feat/model`, `feat/api` and
`feat/explain`. All 1,764 of its rows appear verbatim in this `test_data.csv`, each sampled event is complete, and
re-running `triage/sample.py`'s selection picks the same 150 events (50 per final tier). **The sample was built from
the same test file.**

---

## (a) Repo constraints summary

**Problem statement (README, Challenge #1)**
- Build a collision-risk evaluator. It reads CDM telemetry, "calculates the collision probability (Pc)" and flags
  events that need a manoeuvre.
- Deliverables:
  1. The evaluator, **fit on `train_data`, evaluated on unseen `test_data`**.
  2. A dashboard of trajectories, risk scores and miss distances.
  3. A **24-hour view of how many objects enter the dangerous distance**.
- Allowed columns ("for a simpler model, stick to"): `event_id`, `time_to_tca`, `miss_distance`,
  `relative_speed`, `relative_position_r/t/n`, `c_object_type`, `c_sigma_r`, `t_sigma_r`, `max_risk_estimate`,
  `F10`, `AP`.
- `risk` = log10(Pc) and is **not** in the list. `mission_id` is not in the list either.

**Tiers** (README; code in `triage/tiers.py`). Precedence is worse-of.

| Tier | Rule | Constant in code |
|---|---|---|
| 2 Critical | Pc ≥ 1e-4 (`risk` ≥ −4) **or** miss < 1 km | `RISK_CRITICAL = -4.0`, `MISS_CRITICAL_M = 1000` |
| 1 Elevated | 1e-6 ≤ Pc < 1e-4 **or** 1 km ≤ miss ≤ 5 km | `RISK_ELEVATED = -6.0`, `MISS_ELEVATED_M = 5000` |
| 0 | Pc < 1e-6 **and** miss > 5 km | Display name **"Below threshold"**, never "Safe" |

**Units** (`data/README.md`): `time_to_tca` days · `miss_distance`, positions, sigmas m · `relative_speed` m/s ·
`max_risk_estimate` and `risk` log10. These match our docs.

**Interfaces** (`docs/CONTRACT.md`; change only in a PR that updates every consumer plus `tests/test_triage.py`)
1. **`triage.model.predict(df)`** (owner: Model). The input is **CDM rows**, allowed features only. The output is per
   row: `pred_tier` int 0/1/2, `confidence` 0–1, and `needs_review` bool (uncertainty only ever escalates).
2. **`reports/events.json`** (producer `triage.build_events`, consumers API and dashboard).
   - One object per event, built from the latest CDM. Fields: `tier`, `tier_name`, `confidence`, `needs_review`,
     `reasons`, `cautions` (`needs_review` / `no_covariance` / `pc_diluted`), a `latest{…}` block, `true_tier`, and a
     `history[]` of CDMs.
   - It is sorted by tier, then soonest TCA.
   - The `warnings_24h` block counts events whose latest CDM is ≤ 1 day to TCA, plus how many of those are < 1 km.
3. **`reports/metrics.json`** (producer `triage.evaluate`, consumer the Evaluation tab).
   - It is **per CDM row**. Methods: `majority_class`, `miss_distance_rule`, `max_risk_estimate_rule`, `model`.
   - Fields: `critical_recall`, `critical_precision`, `false_alarm_rate`, `macro_f1`, `confusion`, `by_lead_time`
     (0–1, 1–2, 2–4, 4–7 d) and `missed_criticals`.
   - PR #3 adds `flagged_rate` and `under_tier_rate`.
4. **HTTP API** (`feat/api`): `/api/summary`, `/api/events`, `/api/events/{id}`, `/api/metrics`, `/api/explain/{id}`.

**Team rules** (TEAM.md, PLAN.md, HANDOVER.md)
- `risk` is label-only: "Never add it as a feature."
- Split by `event_id`.
- Say "below threshold", never "safe".
- Every number on screen or in the pitch comes from `metrics.json` / `events.json`, never typed by hand.
- The evaluator must not be the model owner, and can veto a change that lowers Critical recall.
- Show one failure. Label anything synthetic.

**Owners** (TEAM.md)

| Role | Person | Owns |
|---|---|---|
| 1 Visualisation & UI | Reagan | `static/dashboard.*`, `triage/build_events.py`, demo, write-up |
| 2 Model & API + PM | Tommy | `triage/features.py`, `train.py`, `model.py`, `server.py /api/*` |
| 3 Evaluation (independent) | Kalent | `triage/evaluate.py`, `tests/`, baselines, failure cases, "honest eval" slide |
| 4 Integration & trust | Franky | `/api/explain`, dashboard interactions, dilution and needs-review UX |

There is **no "Algorithms" role**. `tiers.py` and `data.py` came from the scaffold PR #2.

**Deadlines** (TEAM.md, build ~10:30–16:30)
- 11:15 scaffold
- 12:30 model v1 + eval table
- 14:00 failure case chosen
- **15:00 feature freeze**, numbers locked in `metrics.json`
- 15:45 pitch rehearsed
- **16:00 submit**

PLAN.md puts submission at ~T+4.5 h.

**Tech stack**
- Python 3.12 with `uv`. CI runs `uv sync --group dev --locked`, then `ruff check .`, `ruff format --check .` and
  `pytest -q` over the **whole repo, including `docs/`**. Tests run on the committed sample with no API key.
- Dependencies are pandas, numpy, scikit-learn, FastAPI and anthropic. **There is no lightgbm, shap or torch.**
- The model on PR #3 uses sklearn `HistGradientBoostingClassifier`.

**Current team model** (PR #3, merged; written up in `docs/ALGO.md`, which says `risk` "is never a model input")
- It is a per-CDM **nowcast**. It demotes CDMs that the conservative `max_risk_estimate` rule over-warns.
- Its threshold is chosen for ≥ 99% recall on truly-Elevated rows, split-conformal style.
- It never touches Critical. It treats the sigma sentinel (63,781,360 m) as "diluted" and never demotes those rows.
- It is scored on test_data's 24,484 CDMs.

---

## (b) Conflicts and gaps

Ordered by severity. Rows 1 to 6 block integration. The rest are wording or planning fixes.

| # | Item | Our doc says | Repo says | Suggested fix |
|---|---|---|---|---|
| 1 | **`risk` as a model input** | Persistence = tier of the latest ≥ 2 d CDM computed from `risk`. Framework A features: risk latest/max/mean/slope/delta and T₀ from `risk`. Kelvins L uses latest `risk`. | README's allowed list leaves out `risk`. data/README: "label only… Never a model input". HANDOVER: "Never add it as a feature." | Team decision (Tommy as PM, with Kalent). **Recommend allowed columns only.** The miss-only persistence baseline is acc 0.935, Crit R 0.820, F2 0.818, 0/244, which matches or beats the risk version. Re-base T₀ on miss distance plus `max_risk_estimate`. Keep the risk-based rows and Kelvins L as a labelled "reference, uses label column" only. |
| 2 | **Two models, one story** | Framework A is "the decision engine" with a conformal guarantee. feature.md §2 offers "Guaranteed-safe triage". | PR #3 (merged, `docs/ALGO.md`) already ships a per-CDM triage model with a ≥ 99% recall threshold. It is the team's `predict()`. ALGO.md lists "no test CDM is within 2 days of TCA" as a known limit. | Position A as a **forecast layer on top of** the nowcast: "what will the tier be at TCA", per event. It does not replace `predict()`, and it answers ALGO.md's known limit. algorithm.md should defer to ALGO.md for the nowcast. Agree one pitch narrative with Tommy. |
| 3 | **Evaluating on test_data** | §1.1: test has no final-risk label (true). §1.4: "test_data.csv has no labels… not for scoring". | README: "evaluate on unseen test_data". test_data has `risk` on 100% of CDMs; per-CDM tiers are 15,756 / 6,501 / 2,227. `evaluate.py` and PR #3 score on test. | Reword: "test has per-CDM labels but **no CDM < 2 d**, so the *final-tier forecast* can only be scored by CV on train". Per-CDM test scoring stays with `evaluate.py`. State both protocols in the pitch. |
| 4 | **"Per-CDM classifiers leak"** | algorithm.md §2.5 row 1 and feature.md "What most solutions will look like": classifying each CDM is a leak or adds no information. | The team's own PR #3 model classifies CDM rows **without `risk`**. That is a real estimation problem, not a leak. | Narrow the claim: "classifying CDMs **with `risk` as an input** leaks". Otherwise the pitch attacks our own team's model. |
| 5 | **Output files** | §4.1: `events_scored.csv`, `triage.csv`, `forecast.csv` handed to the dashboard team. | The dashboard reads only `events.json` / `metrics.json` via `/api/*`. New fields need a contract PR. `build_events.py` is Reagan's file. | Drop the CSVs. Propose a contract PR adding an optional `forecast` object per event and a `forecast` block in `metrics.json` (see §e). |
| 6 | **Rule-engine output vs label** | Phase 1 `rules.py` gives each event a `tier` from `risk` + miss, shown on the dashboard. | That value is `true_tier` (the label). CONTRACT: show `true_tier` / `risk_log10` "only in the evaluation view". The live tier is `pred_tier`. | The forecast feeds `pred_tier`-side fields. The risk-based tier appears only in the evaluation view. |
| 7 | **24-hour view on test** | `in_24h`, `danger_flag` columns, undefined on test. | `build_events` counts events with latest CDM ≤ 1 d. test_data's minimum `time_to_tca` is 2.000, so **the count is 0 on test** (HANDOVER: "say so"). | **Opportunity:** our forecast is the only honest way to fill the README's 24 h view on test, e.g. "events forecast within 1 km at TCA, by TCA day". Add `warnings_24h.forecast_within_dangerous_distance` in the same contract PR. |
| 8 | **Metrics schema** | F2, escalations caught, auto-clear %, Kelvins L, coverage. Unit = event at the 2 d cutoff. | `metrics.json` is per-CDM with recall / precision / false-alarm / macro-F1 / confusion and has none of ours. | Add a `forecast` section, owned by evaluate.py's owner. Also report **false escalations**, because "escalations caught" alone is gameable (see §d-4). |
| 9 | **Ownership** | Header "Owner: Algorithms (Chai)". Roadmap puts prep, rules, baselines, models, metrics and test inference in one team. | No Algorithms role and no "Chai" in TEAM.md. Model = Tommy, eval = Kalent, events = Reagan, explain = Franky. **The evaluator must not be the model owner.** | Add an "Algorithms (forecast)" row to TEAM.md, naming the person. Forecast **metrics and baselines** go in `evaluate.py` under the evaluator. If the algorithms lead is also the evaluator, hand forecast evaluation to someone else. |
| 10 | **Timeline** | 5 h roadmap. Integration at 4:15–4:30, buffer 4:30–5:00, numbers into feature.md at 3:45–4:15. | Freeze 15:00, submit 16:00. PLAN: submit ~T+4.5 h. HANDOVER at ~11:15 shows the day already started. | Even from 10:30, integration ends exactly at the 15:00 freeze with no buffer. Any later start overruns. Cut B now (or run it as a post-freeze experiment), land A + metrics before ~14:00, and integrate by 14:30. |
| 11 | **Tech stack** | LightGBM, shap, PyTorch. | Locked deps have none. CI runs `uv sync --locked`. PR #3 uses sklearn HGB. | Use sklearn `HistGradientBoostingClassifier` (handles NaN and categoricals, has class weights). Make reasons template-based, or put shap in an optional group. Put torch in an optional dependency group outside CI. |
| 12 | **Wording** | "Safe", "Always Safe", "{Safe} only → AUTO-CLEAR", "Guaranteed-safe triage". | "Never 'Safe' — tier 0 is 'Below threshold'". | Rename: "Below threshold", "Always below threshold", "Coverage-controlled triage". |
| 13 | **"Guaranteed" coverage** | "Guarantee a maximum Critical miss rate"; "the safety margin is guaranteed". | — | Conformal coverage holds on average and assumes exchangeability. Only 551 Critical eval events (about 110 per calibration split) means ±2–4 pt swings, and it does not carry over to a shifted live mix. Say "target ≥ 95%, measured X% in CV". |
| 14 | **Hand-typed numbers** | feature.md: "0.930 vs 0.929", "0 of 244", "895 of 908". `[X]` filled "from algorithm.md §4, Phase 7". | TEAM: every pitch number comes from `metrics.json` / `events.json`. | Have `evaluate.py` emit these (incl. the miss-vs-Pc breakdown). Fill the `[X]`s from `metrics.json` at the 15:00 freeze. |
| 15 | **Pc calculation** | "We do not recompute Pc; use ESA's `risk` as authoritative." | README: the evaluator "calculates the collision probability". | Fine as a label policy. Say so explicitly: **inputs** are the allowed columns, with `max_risk_estimate` as the Pc upper bound. `risk` defines the truth only. |
| 16 | **Event IDs** | — | `event_id` restarts at 0 in both files (train 0–13153, test 0–2166). | Never merge train and test on `event_id` alone. Key on `(split, event_id)`. |
| 17 | **Tests need train-like data** | — | The committed sample comes from **test_data** (no CDM < 2 d), so the forecast filter yields **0 events** on it. | Forecast tests need a small synthetic fixture (see §e). |

---

## (c) Reproduced numbers

Commands:
- `uv run --with lightgbm python -I docs/algorithm/baseline.py train_data.csv` (4 m 41 s)
- An independent script written from scratch: `verify_claims.py` in this session's scratchpad. It does not import
  baseline.py, uses the true last row per event, and implements its own F2 and Kelvins L.

Environment: pandas, numpy and scikit-learn from `uv.lock`, plus the latest lightgbm.

| Claim | Expected | Actual | Match? |
|---|---|---|---|
| Train size | 162,634 CDMs / 13,154 events | 162,634 / 13,154 | ✅ |
| Test size | 24,484 CDMs / 2,167 events | 24,484 / 2,167 | ✅ |
| CDMs per event | ~12, between 1 and 23 | train mean 12.36, 1–23 (test 11.30, 1–17) | ✅ |
| `risk` on the −30 floor | 41% of rows | 41.3% train (28.1% test) | ✅ |
| Evaluation events | 8,293 | 8,293 | ✅ |
| Final tiers | 6138 / 1604 / 551 | 6138 / 1604 / 551 | ✅ |
| Critical share | ≈ 7% | 6.6% of eval events (6.9% of all train events) | ✅ |
| Always below threshold | acc 0.740, macro-F1 0.284 | 0.740, 0.284 | ✅ |
| Persistence | acc 0.929, macro-F1 0.868, P 0.800, R 0.820, F2 0.816, 0/244 | identical (both scripts) | ✅ |
| Escalations | 244 (2.9%) | 244 (2.9%): 145 below→Elev, 10 below→Crit, 89 Elev→Crit. Also **348 de-escalations** | ✅ |
| Plain LightGBM | acc 0.930, macro-F1 0.869, P 0.799, R 0.817, F2 0.813, 21/244 | **acc 0.931, macro-F1 0.868, P 0.798, R 0.809, F2 0.807, 24/244** | ❌ small drift, see note |
| Kelvins L, latest risk | ≈ 0.804 | 0.804 (F2 0.411, MSE_HR 0.330, only 66 high-risk events) | ✅ |
| Features in plain LightGBM | 22 | **23** (`tier_last` is the 23rd) | ❌ doc typo |
| Final-Critical events, all train | 908 | 908 | ✅ |
| … Critical only via miss < 1 km | 895 (98.6%) | 895 (98.57%) | ✅ |
| … via `risk` ≥ −4 | 13 | 13 = **3 Pc-only + 10 both rules** | ✅ (state the split) |
| Same breakdown in the 8,293 eval set | (not stated) | 551 Critical: 545 miss-only (98.9%), 6 with Pc ≥ 1e-4 | info |
| corr(risk, log10 miss) | −0.20 | −0.200 on all train CDMs **including the 41% floor rows**. −0.115 excluding the floor. −0.094 on final CDMs. | ✅ but state the population |
| test_data has no CDM with `time_to_tca` < 2 | 0 | 0 (minimum 2.000; also 0 below 1 d) | ✅ |
| test_data "has no labels" | no labels | `risk` filled on 100% of test CDMs | ❌ per-CDM labels exist |
| **Extra:** miss-only persistence (allowed columns) | — | acc 0.935, P 0.807, R 0.820, F2 0.818, 0/244, under-tier 3.2% | new baseline |
| **Extra:** allowed-columns persistence (`max_risk_estimate` + miss) | — | acc 0.731, P 0.747, R 0.831, F2 0.813, "catches" 38/244 by over-warning | shows §d-4 |

**Note on the LightGBM drift.** A second run gave identical output, so this is **not run-to-run noise**. It is
environment drift. Here: pandas 3.1.0, numpy 2.5.4, sklearn 1.9.1, lightgbm 4.7.0 on Windows. The doc's environment
is unknown, and the fold assignment or LightGBM build likely differs. The drift is small, but the success criterion
"escalations > 21/244" and feature.md's "ties persistence" both rest on this row. Freeze the folds and library
versions (§e) and regenerate the row from `metrics.json`. Both environments agree that plain ML ties or slightly
trails persistence on F2. The qualitative conclusion holds.

---

## (d) baseline.py issues

**Verdict.**
- **No temporal leakage.** Every input feature comes from `inp` (CDMs ≥ 2 d), and targets come from the last CDM.
- **No fold leakage.** There is one row per event, so grouping by `event_id` is automatic.
- **Tier logic** matches `triage/tiers.true_tier` at every boundary: 1000 m and 5000 m are Elevated, −6 is Elevated,
  −4 is Critical.
- **Metric formulas** are correct for what they claim.

These are issues to flag, not to fix silently:

| # | Severity | Issue (line) | Effect on current numbers | Fix |
|---|---|---|---|---|
| 1 | **High** (rules) | `risk` is used as an input: `risk_*` features and `tier_last` (L52–53, 61), persistence `last_t` (L37), Kelvins LRP (L39). | All headline baselines assume `risk` is allowed (see §b-1). | Allowed-columns baselines. Keep risk-based ones as labelled reference only. |
| 2 | Medium | Reads `mission_id` (L7). L66 `groups=tgt.mission_id.values if False else X.index` is dead code. | None. Folds are effectively StratifiedKFold over events. | Drop `mission_id`. Use plain `StratifiedKFold` (or keep the group form) without the dead branch. |
| 3 | Medium | Folds are not saved. "Identical folds for every model" relies on the same seed, row order and sklearn version. | Probably part of the LightGBM drift. | Persist `event_id → fold` once and load it everywhere (§e). |
| 4 | Medium | "Escalations caught" = `esc & (pred >= y)`. Any over-prediction counts and false escalations cost nothing. | Over-warning wins: the `max_risk_estimate` persistence "catches" 38/244 at acc 0.731. There are 348 de-escalations. | Also report false escalations (pred > T₀ while final ≤ T₀) and escalation precision. Judge by Critical F2 together with escalations. |
| 5 | Low (latent) | `groupby().last()` (L17, L19) takes the last **non-null** value of each column separately, not the last row. | F10/AP come from an earlier CDM for 30 target / 21 cutoff events. **No effect today**: `risk` and `miss_distance` have no NaNs, and `feats()` uses the true last row (`iloc[-1]`). | Use `data.latest_cdm` (`idxmin`) or `.tail(1)`. |
| 6 | Low | The −30 floor is treated as a number in `risk_mean/slope/delta`. 56% of cutoff CDMs and 82.5% of final CDMs sit on the floor. | A −30 → −8 move reads as a large slope. | Add `at_floor`, and compute slopes on non-floored values (moot if `risk` is dropped). |
| 7 | Low | The sigma sentinel 63,781,360 m (2,652 train CDMs) goes into `log10(c_sigma_r)` unflagged. | Shows up in top features (`c_sig_r` is #2), possibly partly as a "diluted" signal. | Reuse `features.dilution_flag` / `SIGMA_SENTINEL_M` from PR #3. |
| 8 | Low | Single-input-CDM events: 405 eval events (4.9%) get slope = 0, delta = 0, shrink = 0. | Looks like "flat history". `n_cdm` lets the model tell them apart. | Keep, but document. Optionally set slopes to NaN for n = 1. |
| 9 | Low | NaN F10/AP (6,822 train CDMs) and NaN `c_sigma_r` (11) are passed to LightGBM as NaN. | Handled natively. Fine. | Keep. Say so in the doc. |
| 10 | Low | `precision_score` without `zero_division` (warning on "Always Safe"). Feature importances come from the last fold only (L71). | Cosmetic. "Top features" covers one fold. | `zero_division=0`, and average importances over folds. |
| 11 | Low | `tier()` duplicates `triage.tiers.true_tier`. | Identical logic today. | Import from `triage.tiers`. |
| 12 | Low | Kelvins MSE rests on 66 high-risk events. | L is noisy. 0.804 vs ESA's 0.694 is not like-for-like (the doc already says so). | Keep as reference only. |
| 13 | Info | Train has `time_to_tca` down to −0.150 (CDMs after TCA). | These are used as final targets. | Fine. Note it. |
| 14 | **CI** | A script with no `main` guard. ruff finds **11 errors** (E401, E702 ×6, E731, E741, E501, I001), and `ruff format --check` fails. `lightgbm` is not a dependency. | Committing `docs/algorithm/` as-is **fails CI** (`ruff check .` covers docs/). | Port into `triage/` (§e), or add `extend-exclude` in a shared-config PR until it's retired. |

---

## (e) Integration plan (proposal, nothing built)

Principle: reuse the existing modules for rules, data loading and metrics. Add only the forecast-specific pieces. Keep
the per-CDM nowcast (PR #3) and the per-event forecast as two clearly named tasks sharing one tier engine.

**Prep: `triage/forecast_data.py`** (new; owner: Algorithms)
- `eval_events(df)`: the Kelvins filter (≥ 1 CDM at ≥ 2 d, final < 1 d).
- `split_cutoff(df, cutoff_days=2.0) -> inputs, targets`: targets come from `data.latest_cdm` (true last row).
- `make_folds(targets, n_splits=5, seed=0)`: StratifiedKFold on final tier, written to
  `data/folds/forecast_folds.csv` (`event_id, fold`). Commit it: it holds ids only, about 70 KB.
- CLI `uv run python -m triage.forecast_data` prints `8293 events, tiers [6138 1604 551]` as its acceptance check.

**Rules: reuse `triage/tiers.py`**
- Use it as-is: it is already the tier engine, with identical logic.
- Do **not** add `rules.py`.
- The 24 h warnings stay in `build_events.py` (Reagan). The forecast adds a forecast-based count through the contract
  PR below.

**Eval: extend `triage/evaluate.py`** (owner: Kalent, the independent evaluator)
- Add `evaluate_forecast()`, which writes `metrics.json["forecast"]`.
- Baselines: miss-only persistence, allowed-columns persistence, always below threshold, plus a risk-based persistence
  labelled `reference_uses_label`.
- Metrics: reuse `score()` and add `critical_f2`, `escalations_caught`, `false_escalations`, `auto_clear_rate` and
  `critical_coverage`. Add Kelvins L as reference only.
- Also emit the miss-vs-Pc Critical breakdown, so feature.md's numbers come from `metrics.json`.

**Framework A: `triage/forecast_features.py` + `triage/forecast_model.py`** (owner: Algorithms)
- Event features from **allowed columns only**. Reuse `features.dilution_flag`.
- sklearn HGB with class weights.
- Mondrian conformal, calibrated inside the training folds.
- `predict_events(df) -> DataFrame[event_id, p_below, p_elevated, p_critical, prediction_set, decision, reasons]`,
  with the artifact saved to `reports/forecast_model.joblib`.
- Scored by `evaluate.py` on the saved folds.

**Framework B: `experiments/forecast_gru.py`**
- Lives outside `triage/`, with torch in an optional `[dependency-groups] nn` that CI never syncs.
- Loads the same folds file and calls the same `evaluate.py` scoring functions.

**Tests: `tests/test_forecast.py`** with a synthetic fixture in `conftest.py`. The committed sample has no < 2 d CDMs.
The fixture covers:
- a single-CDM-at-cutoff event
- −30 floor values
- NaN F10
- a below→Critical escalation
- the 1000 m and 5000 m boundaries

The tests assert:
- inputs are all ≥ 2 d
- target = true last row
- folds partition events and are stable on reload
- persistence catches 0 escalations
- the metrics match a hand-computed example

**Contract PR** (one PR updating every consumer plus `tests/test_triage.py`)
- `events.json` events get an optional `forecast` object: `{p_final: [3], prediction_set, decision, reasons}`.
- `warnings_24h` gets `forecast_within_dangerous_distance`.
- `metrics.json` gets a `forecast` block.

**`docs/algorithm/baseline.py`**: keep it as the reference until `evaluate.py` reproduces its numbers, then delete it.
Until then, exclude it from ruff or move it out of the linted tree.

**Order**
1. Prep, folds and tests.
2. `evaluate.py` forecast baselines.
3. Framework A.
4. Contract PR, with `build_events` and the dashboard.
5. B, only if time allows.

Each step is its own PR. The evaluator posts the table on step 3, per TEAM rules.

---

## (f) Edits needed in algorithm.md / feature.md

**algorithm.md**
1. Header: replace "Owner: Algorithms (Chai)" with the TEAM.md role and person once that row is added (§b-9).
2. §1.1 and §1.4: test has per-CDM `risk` (100%) but no CDM < 2 d. Say "no **final-tier** labels", and note that
   per-CDM test scoring is done by `evaluate.py` (README deliverable).
3. §1.3: tier 0 is called "Below threshold".
4. §1.4 and §3 A features: inputs = allowed columns only (pending the §b-1 decision). Drop risk features. T₀ from
   miss distance plus `max_risk_estimate`.
5. §1.4 metrics: add false escalations and escalation precision next to "escalations caught".
6. §2.2: state the population ("all 13,154 train events, last CDM"). Split the 13 into 3 Pc-only and 10 both. Add the
   eval-set figure (545/551). Say the −0.20 correlation is CDM-level, including floor rows (−0.115 without).
7. §2.4 table:
   - rename "Always Safe"
   - fix 22 → 23 features
   - replace the LightGBM row with the regenerated value
   - add the miss-only and allowed-columns persistence rows
   - mark risk-based rows as "reference (uses label column)"
8. §2.5 row 1: narrow it to "with `risk` as input". Don't describe the team's per-CDM nowcast as a leak.
9. §3 A: "guarantee" becomes "target ≥ 95% Critical coverage, measured in CV", with the exchangeability and sample-size
   caveat. Rename "{Safe} only → AUTO-CLEAR" to "{Below threshold} only".
10. §3: frame A as a per-event forecast layer **alongside** the PR #3 nowcast, not "the decision engine".
11. §4 roadmap:
    - re-time against TEAM.md clock times (freeze 15:00)
    - cut B to optional now
    - Phase 1 becomes "reuse tiers.py"
    - name owners per phase
    - feature.md numbers come from `metrics.json`
12. §4.1: replace the three CSVs with the `events.json` / `metrics.json` contract additions (§e).
13. Tooling: sklearn HGB instead of LightGBM; shap optional; torch in an optional group.

**feature.md**
1. Feature 2 title becomes "Coverage-controlled triage". Replace "guaranteed" claims with measured coverage.
   AUTO-CLEAR = "below threshold only".
2. "What most solutions will look like": narrow the leak argument to "with `risk` as input". "0.930 vs 0.929" will
   change with the LightGBM regeneration and the allowed-columns baselines. Pull it from `metrics.json`.
3. Feature 1 proof: the `[X]/244` should sit beside a false-escalation count. "Critical recall ≥ 0.82" still holds
   for miss-only persistence (0.820).
4. Feature 2 and the side-by-side table: acknowledge the team's PR #3 demotion model. Present nowcast and forecast as
   one system.
5. Feature 3: "895 of 908 … just 13" is correct. Add "(3 from Pc alone)" and the population. Note that per-flag
   Pc-vs-miss reasons already exist in `events.json` `reasons` (`tiers.reasons`).
6. Add the 24 h forecast view as a concrete deliverable. It is the only way to fill the README's 24 h view on test
   data (§b-7).
7. The literature claims (12 of 97 teams, L = 0.694, Neuraspace numbers) were **not** re-verified here. They are taken
   as cited.

Status: the edits above are applied in algorithm.md v1.1 and feature.md. Exception: the TEAM.md role row (§b-9) needs
the PM.

---

## (g) Resolution: `risk` as a model input

**Decision: follow the team rule. `risk` is label-only, so no override.**

- **Evidence so far:** at the persistence level, the allowed-columns baseline (miss distance only) matches or beats
  the `risk` baseline on every metric (acc 0.935 vs 0.929, F2 0.818 vs 0.816, same recall 0.820, both 0/244).
- **Why it holds:** the final tier is almost never set by Pc. 545 of 551 final-Critical evaluation events are Critical
  from miss distance only.
- **Model-level test:** `docs/algorithm/risk_ablation.py` compares gradient boosting on allowed columns vs allowed +
  `risk`, for LightGBM and sklearn HGB, over 5 fold seeds. The decision rule was fixed before running: override only
  if `risk` adds > 0.01 Critical F2 or macro-F1 **and** > 2× the seed-to-seed spread.
- **Status:** the run was **stopped before it finished** (time limit) and these docs were pushed without its result.
  Re-run it with:
  `uv run --with lightgbm python -I docs/algorithm/risk_ablation.py train_data.csv` (about 20+ min on a laptop CPU).
- **If the run shows a gain beyond the rule:** raise it with the PM before using `risk`. That needs a change to
  `docs/ALGO.md`, `data/README.md` and the HANDOVER gotchas, not just these docs.

**Repo changes made with this resolution**
- `pyproject.toml`: `extend-exclude` for `docs/algorithm/baseline.py`, so CI lint passes while the original script
  stays byte-for-byte as the source of v1.0's numbers.
- `risk_ablation.py` passes ruff.
