# Algorithm design: collision risk forecaster

**Challenge #1: AI-driven satellite collision avoidance**
Owner: Algorithms (Chai); this role still needs adding to `docs/TEAM.md` · Version 1.1 · 31 Oct 2026
Changes from 1.0 and the evidence behind them are in [`VERIFICATION.md`](VERIFICATION.md).

This document extends the team's algorithm write-up, [`docs/ALGO.md`](../ALGO.md). That doc covers the **nowcast**:
the tier of each CDM as it arrives. This doc covers the **forecast**: the tier an event will end at by closest
approach. The two share one rule engine (`triage/tiers.py`) and the same allowed columns.

---

## 1. Problem framing

### 1.1 What the data is

The dataset is the ESA Kelvins Collision Avoidance Challenge data (CDMs from 2015–2019, published with [Uriot et al., 2021](https://arxiv.org/html/2008.03069v2)).

| Item | Value |
|---|---|
| Unit of data | One row = one **CDM** (Conjunction Data Message), an updated warning about one close approach |
| Event | A time series of CDMs for one satellite–object pair, from about 7 days before TCA (time of closest approach) down to 0. On average 12 CDMs, between 1 and 23 |
| Train | 162,634 CDMs / 13,154 events |
| Test | 24,484 CDMs / 2,167 events. Every CDM has `risk`, so the per-CDM tier can be scored (the nowcast is scored there). But **no CDM is closer than 2 days to TCA**, so there is no final-tier label. |
| Target | `risk` = log₁₀(Pc), already computed by ESA. It is floored at −30; 41% of train rows sit on the floor (28% of test). **Label only, never a model input** (§1.4, §2.4). |
| Units | `time_to_tca` in days, `miss_distance` in metres, `max_risk_estimate` in log₁₀ |
| IDs | `event_id` restarts at 0 in each file. Never join train and test on it. |

### 1.2 What kind of problem it is

The challenge mixes two different problems.

1. **Assessment (deterministic):** read a CDM, take its Pc and miss distance, and assign a tier. This is physics plus fixed thresholds. ML must not replace it. Estimating each CDM's tier from the allowed columns (where only the Pc upper bound `max_risk_estimate` is available) is the team's nowcast, in `docs/ALGO.md`.
2. **Forecasting (where this work adds value):** given the CDMs received so far, predict what the tier will be **at closest approach**. Pc moves as tracking improves, and the NASA handbook notes that "the event color often changes as the event progress[es] (and regresses)." Operators must decide on a maneuver at the **maneuver commitment point, typically 0.5–1 day before TCA** ([NASA CA Handbook, App. F](https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf)). An earlier, reliable forecast buys planning time. It is also the only way to fill the brief's 24-hour view on the test data, where no CDM is within 2 days of TCA.

Properties of the forecasting problem:

- **Grouped short time series**, which can be flattened to one row per event
- **Ordinal 3-class target**
- **Heavily imbalanced** (Critical ≈ 6.6% of evaluation events)
- **Censored** (the −30 floor)
- **Strong autocorrelation:** the latest value is a very strong predictor

### 1.3 Risk tiers (from the challenge brief)

| Tier | Rule |
|---|---|
| Below threshold | Pc < 10⁻⁶ **and** miss distance > 5 km |
| Elevated | 10⁻⁶ ≤ Pc < 10⁻⁴ **or** 1 km ≤ miss distance ≤ 5 km |
| Critical (maneuver required) | Pc ≥ 10⁻⁴ (risk ≥ −4.0) **or** miss distance < 1 km |

The worse tier wins. The code is `triage/tiers.py`, and we reuse it rather than re-implementing it. Tier 0 is always called "below threshold", never "safe".

### 1.4 Evaluation protocol

This is the same protocol as ESA's competition.

- **Events used:** at least one CDM ≥ 2 days before TCA, and the final CDM < 1 day before TCA. That leaves **8,293 events** in train.
- **Model input:** only CDMs with `time_to_tca ≥ 2`, and only the allowed columns. `risk` defines labels (the final tier, and the true tier at the cutoff used to define escalations) and is never an input. Evidence so far says it isn't needed (§2.4).
- **Label:** the tier of the final CDM.
- **Split:** 5-fold stratified split over events, grouped by `event_id`, so no event appears in both training and validation. The fold of each event is **saved to disk once and loaded by every model**, so every model uses identical folds.
- **Test data:** `test_data.csv` has per-CDM labels but no CDM < 2 days. The **forecast** is therefore scored by cross-validation on train, while the **nowcast** is scored per CDM on test (`triage/evaluate.py`). We use test_data for live forecast inference on the dashboard.
- **Primary metrics:**
  - Critical recall
  - Critical F2 (recall weighted ×2 over precision, as ESA recommends)
  - **Escalation recall:** of the events whose final tier is higher than their true tier at the 2-day cutoff, how many we flag at or above their final tier
  - **False escalations:** events we flag above their cutoff tier that did not escalate. Reported next to escalation recall, because over-warning "catches" escalations for free.
  - Workload: % of events auto-cleared

---

## 2. Research review (validated 31 Oct 2026)

### 2.1 How Pc is computed (assessment)

| Method | Use | Source |
|---|---|---|
| 2D Pc (Foster / Alfano / Chan / Patera) | Standard for short, fast encounters. Projects the combined covariance onto the encounter plane and integrates over the hard-body circle. | NASA CA Handbook; NASA CARA |
| Monte Carlo Pc | Long or slow encounters where the 2D assumptions break | NASA CARA |
| **Our position** | Our allowed columns lack the full covariance (only radial sigmas) and the hard-body radius, so we **do not recompute Pc**. ESA's `risk` defines the true tier. At prediction time, the Pc information we use is `max_risk_estimate`, ESA's upper bound on Pc, which is an allowed column. | — |

### 2.2 What the NASA handbook says about miss distance

This is important, and it is validated.

- "The lack of any strong correlation between Pc and miss distance is clear."
- A miss-distance cutoff "is ill-advised because it would result in a huge number of unnecessary mitigations."
- Pc ≥ 1E-04 is "an acceptable balance" that "has emerged in the industry," not a regulation.

Source: [NASA CA Handbook Rev 2, App. E–G](https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf).

**Our data agrees.**
- Of all 13,154 train events, 908 have a Critical last CDM. **895 of them (98.6%) are Critical only because of the < 1 km miss-distance rule.**
- Only 13 cross Pc ≥ 10⁻⁴, and 10 of those are also under 1 km. Just 3 are Critical from Pc alone.
- In the 8,293 evaluation events the picture is the same: 545 of 551 Critical events (98.9%) come from miss distance only.
- The correlation between risk and log₁₀ miss distance is −0.20 across all train CDMs. That figure includes the 41% of rows on the −30 floor; it is −0.12 without them.

### 2.3 ML forecasting literature

| Work | Approach | Result vs "latest value" baseline | Takeaway |
|---|---|---|---|
| [Uriot et al. 2021, ESA Kelvins competition](https://arxiv.org/html/2008.03069v2) | 97 teams | Latest-risk baseline L = 0.694. **Only 12 teams beat it.** Winner (sesc, L = 0.556) used threshold rules *on top of* the latest risk. 3rd place (Magpies) used a Siamese LSTM plus anomaly detection. A LightGBM follow-up gained ≈ 1.3% F2. | **The baseline is the bar. Anchoring on it wins.** |
| [Abay et al. 2021, Neuraspace benchmark (ESA SDC8)](https://conference.sdo.esoc.esa.int/proceedings/sdc8/paper/123/SDC8-paper123.pdf) | BNN, Siamese, CatBoost, LDA | Naive F2 0.638. Best was **LDA stacked on naive, 0.640**. The **BNN was slightly worse than naive** (RMSE 29.22 vs 29.06). | Stand-alone Bayesian NNs on absolute risk don't win. Stacking on the baseline does. |
| [Acciarini et al. 2020, Oxford/ESA, Kessler library](https://arxiv.org/pdf/2012.12450) | 2×256 LSTM with MC dropout, forecasts the next full CDM | Feature MSE 0.142 vs 0.243 naive | Bayesian sequence models are good at forecasting **CDM fields with uncertainty**, but this was not tested on the risk decision. |
| [NASA CARA AI/ML Compendium, AMOS 2025](https://amostech.com/TechnicalPapers/2025/ConjunctionRPO/Mashiku.pdf) | Review of NASA's internal ML trials | Gains over Pc thresholds were "marginal". "Fully automated AI/ML decision systems are not currently viable." | NASA wants ML for **triage and prioritisation**, with **explainability**, **uncertainty quantification** and **validation against baselines**, keeping Pc at the core. |
| [Ouari et al. 2026, Applied Intelligence](https://link.springer.com/article/10.1007/s10489-026-07494-6) | Stacked GBM + DNN ensemble, Monte Carlo, calibration | F2 0.808, AUC 0.981. The abstract shows no comparison against the naive baseline. | Calibration is now expected. Be sceptical of results with no baseline. |
| [Tüylek Tok et al. 2026, arXiv 2609.13191](https://arxiv.org/abs/2609.13191) | TCN–Transformer forecasting the next-CDM PoC (TÜBİTAK data) | No baseline in the abstract | Heavy deep sequence models are a crowded direction. |
| [UTEP thesis 2026, Forecast–Pareto–Conformal MDP](https://scholarworks.utep.edu/open_etd/4770/) | ML forecasts of miss distance/Pc, conformal bounds, maneuver optimisation | Reports reliable conformal coverage | Conformal prediction is valid for CDMs. It has been applied to **regression bounds**, not to **tier triage with a measured Critical miss rate**. |

The Kelvins and Neuraspace numbers above are as published. We did not re-run them.

### 2.4 Our own baseline results

5-fold out-of-fold results on the 8,293 train evaluation events. Script: [`risk_ablation.py`](risk_ablation.py)
(`uv run --with lightgbm python -I docs/algorithm/risk_ablation.py train_data.csv`). Models are shown as the mean
(standard deviation) over 5 fold seeds. 244 events (2.9%) escalate after the cutoff.

| Model | Inputs | Accuracy | Macro-F1 | Critical P | Critical R | Critical F2 | Escalations caught |
|---|---|---|---|---|---|---|---|
| Always below threshold | none | 0.740 | 0.284 | 0 | 0 | 0 | 0 / 244 |
| **Persistence, miss distance only** | allowed | **0.935** | — | 0.807 | 0.820 | **0.818** | 0 / 244 |
| Persistence, `max_risk_estimate` + miss | allowed | 0.731 | — | 0.747 | 0.831 | 0.813 | 38 / 244 (by over-warning) |
| Persistence, `risk` + miss | *reference: uses the label column* | 0.929 | 0.868 | 0.800 | 0.820 | 0.816 | 0 / 244 |
| Plain LightGBM, v1.0's 23 features | *reference: uses `risk`* | 0.931 | 0.868 | 0.798 | 0.809 | 0.807 | 24 / 244 |
| Gradient boosting, allowed vs allowed + `risk`, 5 seeds | — | *pending: `risk_ablation.py` run not finished when v1.1 was pushed* | | | | | |

The plain LightGBM row is reproduced on pandas 3.1 / sklearn 1.9.1 / lightgbm 4.7.0. Version 1.0 reported 0.930 / 0.869 / 0.799 / 0.817 / 0.813 / 21 from a different environment. Macro-F1 for the two allowed-columns persistence rows will come from `risk_ablation.py`.

For reference, on the Kelvins metric the latest-risk baseline scores L = 0.804 on our train events, versus 0.694 on ESA's hidden test set. That baseline uses `risk` as its input by definition, so we use it only to compare with the literature, not as one of our baselines.

**Should `risk` be an input?** Not on current evidence, so we follow the team rule (`risk` is label-only).
- At the persistence level, the allowed-columns baseline (miss distance only) matches or beats the `risk` baseline
  on every metric: accuracy 0.935 vs 0.929, F2 0.818 vs 0.816, same Critical recall.
- The reason is the miss-distance finding in §2.2: the final tier is almost never set by Pc.
- The model-level test is `risk_ablation.py`. The decision rule is fixed in its docstring: `risk` is worth an
  override only if it adds > 0.01 Critical F2 or macro-F1 and > 2× the seed-to-seed spread. Its result goes here
  when the run finishes.

**Conclusion:**

- Plain ML ties persistence, which matches every paper above.
- Persistence, by definition, **never** catches an escalation. 244 events (2.9%) escalate after the 2-day cutoff: 145 from below threshold to Elevated, 10 from below threshold to Critical, and 89 from Elevated to Critical.
- 348 events de-escalate, so a model can "catch" escalations by over-warning. The `max_risk_estimate` persistence catches 38/244 at an accuracy of 0.731. Escalations must be read together with false escalations and Critical F2.
- **That gap is where the value is.**

### 2.5 What other teams will most likely build, and why we won't

| Common approach | Problem |
|---|---|
| XGBoost or random forest classifying each **CDM row** into a tier **with `risk` as an input** | Leaks the answer: the tier is a deterministic function of `risk` and miss distance in the same row. Accuracy looks near-perfect but means nothing. (Classifying CDMs *without* `risk`, as our nowcast does, is a real estimation problem.) |
| Random train/test split by row | The same event appears on both sides, which inflates scores. |
| Accuracy as the headline metric | 74% of evaluation events end below threshold, so "always below threshold" already scores 0.74. |
| LSTM or Transformer predicting absolute risk | The published BNN did worse than persistence, and it's a black box. NASA flags this. |
| No baseline comparison | Unverifiable. Judges and NASA CARA both ask "vs what?" |

---

## 3. Recommended frameworks

### Framework A: Persistence-anchored escalation model with conformal triage (primary)

**Idea:** don't re-predict the risk. Predict whether the **current tier will change** before TCA, then wrap the output in **class-conditional conformal prediction** with a target maximum Critical miss rate, so the system knows when it may auto-clear an event. This is a per-event layer **on top of** the nowcast in `docs/ALGO.md`. It doesn't replace `triage.model.predict()`.

```
CDM history (≥2 d, allowed columns) ─► Rule engine (tiers.py) ─► T₀ = miss-distance tier, Pc-upper-bound tier
                                    └► Event features ─► gradient boosting ─► P(final tier = k | T₀, history)
                                                                   │
                                    Mondrian conformal (per class, α = 0.05)
                                                                   ▼
                       prediction set ⊆ {Below threshold, Elevated, Critical}  ─►  triage decision
                             {Below threshold} only  → AUTO-CLEAR
                             contains Critical       → MANEUVER PLANNING
                             anything else           → ANALYST REVIEW
                                                                   ▼
                                    top-3 reasons per event (plain English)
```

**Why this framework:**

| Reason | Evidence |
|---|---|
| Anchoring on the latest value is the only pattern that has reliably beaten the baseline | Kelvins winner (rules on latest risk). Neuraspace best model (LDA stacked on naive). |
| It is anchored on persistence | The current tier T₀ is a feature, so the model can fall back to it. §2.4 shows how close it lands to persistence. |
| It targets exactly what persistence misses | 0/244 escalations caught by the baseline. |
| Conformal prediction gives a **distribution-free coverage target** with no Bayesian assumptions | Proven on CDM forecasts in the UTEP 2026 thesis. We apply it to tier triage, which none of the reviewed works do. The team's nowcast already uses the same split-conformal idea for its demotion threshold. |
| It matches NASA CARA's stated role for ML: triage, explainable, uncertainty-aware, baselined | AMOS 2025 compendium |
| It fits the time budget | About 2 h of work, trains in seconds |

**Technical details:**

- **Features**, computed per event from the CDMs at ≥ 2 days, allowed columns only:
  - Pc upper bound (`max_risk_estimate`): latest, max, mean, slope over time, change from first to last
  - Miss distance: latest, min, slope of log miss distance
  - Uncertainty: log `c_sigma_r` and `t_sigma_r`, and **how much `c_sigma_r` shrank** (from first to latest CDM). The sigma sentinel (63,781,360 m) is treated as missing and flagged, reusing `triage.features.dilution_flag`.
  - Encounter geometry: relative speed, R/T/N position
  - Object type: debris or payload flag
  - Space weather: F10 and AP (NaN is left as NaN; the model handles it)
  - CDM count, time of latest CDM, and **T₀** (miss-distance tier and Pc-upper-bound tier)
- **Model:** scikit-learn `HistGradientBoostingClassifier`, class-weighted, 400 iterations, learning rate 0.03. It is already a locked dependency (the nowcast uses it). `risk_ablation.py` compares it with LightGBM (§2.4, pending).
- **Conformal step:**
  - Split the training folds into fit and calibration parts.
  - Nonconformity score = 1 − p(true class).
  - Compute **per-class quantiles (Mondrian)**, so the target applies *to Critical specifically*, not just on average.
  - Implemented in plain numpy, about 20 lines. MAPIE is optional.
  - **Caveat:** coverage holds on average for events drawn like the calibration events (exchangeability). It is not a per-event guarantee. With 551 Critical events, each calibration split holds only about 110, so measured coverage will swing by ±2–4 points between folds.
- **Explanations:** top 3 drivers per event, mapped to plain English (for example, "miss distance shrinking"). Use template reasons from feature deltas, consistent with `triage/explain.py`. SHAP TreeExplainer is optional.

**Success criteria:**

- More escalations caught than the plain gradient-boosting model in §2.4, **with false escalations reported**
- Critical recall ≥ 0.82 (no worse than persistence)
- Empirical Critical coverage ≥ 95% on held-out folds
- A reported auto-clear %

### Framework B: Residual Bayesian GRU (stretch goal, time-boxed)

**Idea:** a small recurrent network reads the raw CDM sequence (allowed columns) and predicts the **change** in log₁₀ miss distance and in risk from the latest CDM to TCA, not the absolute values. The risk change is measured against the latest Pc upper bound (`max_risk_estimate`), because `risk` itself is not an input. MC dropout at prediction time gives a predictive distribution. The tier is then derived by running the **same rule engine** on the predicted final values.

```
CDM sequence (≥2 d, ≤23 steps, ~15 allowed features)
   └► 1-layer GRU (64 units, dropout 0.2)
        └► heads: Δlog₁₀(miss distance),  Δr = r_TCA − max_risk_estimate_latest
             └► MC dropout × 50 samples ─► distribution of final (risk, miss distance)
                  └► rule engine on each sample ─► P(tier) = share of samples per tier
```

**Why this framework:**

| Reason | Evidence |
|---|---|
| Bayesian sequence models do well at forecasting CDM quantities with uncertainty | Acciarini et al. cut forecast MSE by 42% vs naive |
| Predicting the **residual** avoids the known failure of BNNs that predict absolute risk | The Neuraspace BNN on absolute risk lost to naive |
| Predicting miss distance, not just risk, matters because miss distance drives 98.6% of Critical flags | Our data |
| Running the rule engine on each sample keeps the decision on official thresholds. ML forecasts the inputs, not the policy. | NASA CARA: keep Pc and physics at the core |
| Gives the dashboard a **forecast risk curve with uncertainty bands** | Novel visual; the brief asks for "trajectories" |
| An independent second opinion: where A and B disagree, that is itself an uncertainty signal for analyst review | — |

**Handling the −30 floor** (the target side):

- Clip risk to [−30, 0].
- Add a binary input `at_floor` for the Pc upper bound.
- Compute the loss on Δr only where the target isn't floored. Otherwise use a hinge-style penalty on predictions above −30.

**Kill rule:** B is cut from the pre-freeze plan (§4). If it is attempted after the freeze and isn't producing sensible out-of-fold predictions within 45 minutes, stop. Report "explored; did not beat Framework A" as a finding.

PyTorch lives in an optional dependency group that CI never installs.

### 3.1 Why A + B together is defensible

- **A** is the forecast decision layer: fast, explainable, with a measured coverage target.
- **B** is the forecast engine: it shows *how* risk is expected to evolve, with uncertainty.
- Both run **after** the deterministic rule engine and are scored against the **same** persistence baseline on the **same** saved folds.
- Neither replaces the nowcast. The dashboard shows the nowcast tier and, next to it, the forecast.

---

## 4. Build roadmap

Times are counted back from TEAM.md's **15:00 feature freeze**. If a phase starts late, cut from the bottom of the
"cut if behind" order: the 24 h forecast count first, then conformal (fall back to fixed thresholds). B is
post-freeze only.

| Latest window | Phase | Owner | Deliverable | Done when | Cut if behind? |
|---|---|---|---|---|---|
| 12:15–12:45 | **0. Data prep** | Algorithms | `triage/forecast_data.py`: event filter, cutoff split, `data/folds/forecast_folds.csv` | 8,293 events, folds committed | Never |
| — | **1. Rule engine** | — | Reuse `triage/tiers.py` (identical rules). No new file. | — | — |
| 12:45–13:15 | **2. Baselines into eval** | Evaluation (Kalent) | `triage/evaluate.py` forecast section: persistence baselines plus the metrics in §1.4 → `metrics.json["forecast"]` | Reproduces §2.4 persistence rows | Never |
| 12:45–13:45 | **3. Framework A: escalation model** | Algorithms | Out-of-fold tier probabilities on the saved folds | Beats the plain model on escalations, Critical R ≥ 0.82 | Never |
| 13:45–14:15 | **4. Framework A: conformal + reasons** | Algorithms | Prediction sets, decisions, top-3 reasons | Critical coverage ≥ 95% in CV | Use fixed 0.5 thresholds |
| 14:15–14:45 | **5. Inference on test_data + contract PR** | Algorithms + Visualisation (Reagan) | `forecast` object in `events.json`; forecast count in `warnings_24h` | Dashboard loads it | Drop the 24 h forecast count first |
| 14:45–15:00 | **6. Lock results** | Evaluation (Kalent) | Comparison table in `metrics.json`; `[X]`s in `feature.md` filled from it | Numbers frozen | — |
| after 15:00 | **7. Framework B (stretch)** | Algorithms | Out-of-fold distributions of final risk and miss distance | Sensible predictions within 45 min | **Yes, already cut from the main plan** |

**Tooling:** Python, pandas, numpy, scikit-learn (all locked dependencies). Optional and outside CI: lightgbm (comparison only), shap, PyTorch (Framework B). Everything runs on a laptop CPU.

### 4.1 Output contract for the dashboard team

The dashboard reads only `reports/events.json` and `reports/metrics.json` (`docs/CONTRACT.md`). Our outputs go there, through **one contract PR** that updates every consumer and `tests/test_triage.py`. This is a proposal, to agree with Tommy (API) and Reagan (dashboard):

| Where | Addition |
|---|---|
| `events.json` → each event | Optional `forecast`: `{"p_final": [p_below, p_elevated, p_critical], "prediction_set": ["Elevated", "Critical"], "decision": "AUTO-CLEAR" \| "REVIEW" \| "MANEUVER", "reasons": ["…", "…", "…"]}`. Absent when the event has no CDM ≥ 2 days before TCA. |
| `events.json` → `summary.warnings_24h` | `forecast_within_dangerous_distance`: events forecast to end within 1 km. This is the brief's 24-hour view, which is otherwise empty on test data. |
| `metrics.json` | `forecast` block: `{"n_events": 8293, "folds": "data/folds/forecast_folds.csv", "results": {"<method>": {"accuracy", "macro_f1", "critical_precision", "critical_recall", "critical_f2", "escalations_caught", "false_escalations", "auto_clear_rate", "critical_coverage"}}}` |
| `events.json` → each event (B only) | `forecast.curve`: `[{"time_to_tca_days", "risk_p10", "risk_p50", "risk_p90", "miss_p10_m", "miss_p50_m", "miss_p90_m"}]` |

The forecast feeds the prediction side of the event. The tier computed from `risk` (`true_tier`, `risk_log10`) stays in the evaluation view only.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Framework A only modestly beats persistence | Expected, since the whole literature hits this wall. We report it honestly; the coverage target and workload number are the value. |
| Only 244 escalation examples | Class weights. Report the confidence interval on escalation recall, and report false escalations. |
| Leakage between folds | Group by event_id, with folds saved once. Never use CDMs < 2 days before TCA as input. Never use `risk` as an input. |
| Results drift between machines | Folds saved to disk; library versions pinned by `uv.lock`; numbers regenerated from `metrics.json`, not typed by hand. (The v1.0 LightGBM row did not reproduce exactly across environments.) |
| Mission differences (ESA flags these) | Note `mission_id` balance across folds as a known limitation. `mission_id` is not an allowed input. |
| No final labels in test_data | Score the forecast by cross-validation only. Use test_data for the demo; the nowcast covers per-CDM test scoring. |

---

## 6. References

1. Uriot, T. et al. (2021). *Spacecraft collision avoidance challenge: design and results of a machine learning competition.* Astrodynamics. [arXiv:2008.03069](https://arxiv.org/html/2008.03069v2)
2. Abay, R., Caldas, F., Filipe, M., Guimarães, M. (2021). *Benchmarking machine learning models for collision risk prediction in LEO.* 8th European Conf. on Space Debris. [PDF](https://conference.sdo.esoc.esa.int/proceedings/sdc8/paper/123/SDC8-paper123.pdf)
3. Acciarini, G. et al. (2020). *Towards automated satellite conjunction management with Bayesian deep learning.* NeurIPS AI4Earth. [arXiv:2012.12450](https://arxiv.org/pdf/2012.12450). Kessler library: [SDC8 paper 226](https://conference.sdo.esoc.esa.int/proceedings/sdc8/paper/226/SDC8-paper226.pdf)
4. NASA (2026). *Spacecraft Conjunction Assessment and Collision Avoidance Best Practices Handbook, NASA/SP-20205011318 Rev 2.* [PDF](https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf)
5. Mashiku, A. et al. (2025). *NASA CARA Compendium for Artificial Intelligence / Machine Learning.* AMOS. [PDF](https://amostech.com/TechnicalPapers/2025/ConjunctionRPO/Mashiku.pdf)
6. Ouari, M. et al. (2026). *Probabilistic satellite collision risk prediction via Monte Carlo ensembles.* Applied Intelligence 56:443. [Link](https://link.springer.com/article/10.1007/s10489-026-07494-6)
7. Tüylek Tok, R. et al. (2026). *Early prediction of satellite collision probability using a hybrid TCN–Transformer model.* [arXiv:2609.13191](https://arxiv.org/abs/2609.13191)
8. *A Forecast–Pareto–Conformal Markov Decision framework for safe maneuver planning* (2026). UTEP thesis. [Link](https://scholarworks.utep.edu/open_etd/4770/)
