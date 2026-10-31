# Final-tier forecast (the organisers' official task)

**Task** (organisers' `challenge1_event_labels.xlsx`, sheet `data_notes`): predict each event's **final** tier (its last
message before closest approach) using **only messages with `time_to_tca >= 2` days**. Evaluate by splitting
`train_data` by `event_id` (for example 80/20), never splitting an event. `test_data` has no final outcomes, so it gets
demo predictions only.

Code: `triage/forecast_features.py` (labels, the 2-day cut, event features), `triage/forecast.py` (model, bounded
decision layer, evaluation, outputs). Run: `uv run python -m triage.forecast` (about 12 min the first time, because it
refits the nowcast for every split; cached in `reports/forecast_cache/` after that). Every number below comes from
[`data/demo/forecast_metrics.json`](../data/demo/forecast_metrics.json).

## Labels

- The xlsx `final_tier` agrees with the tier we recompute from `train_data`'s last message (`risk` + miss distance,
  `triage/tiers.py`) on **13,154 of 13,154 events (100%)**.
- **Cohort (organisers' definition):** `usable_for_training == yes`, meaning at least one message 2+ days out. That
  is **11,942 events**: 8,946 below threshold, 2,162 Elevated, 834 Critical. `usable_for_training` matches "has a
  message >= 2 d" on every event.
- 3,050 of those events have their final message itself 2+ days out, so the final message is one of the inputs.
  270 events escalate after the 2-day cut and 378 de-escalate (true tier at the latest >= 2 d message vs final tier).
- **Secondary cohort:** Kalent's 8,293-event protocol (final message < 1 day before TCA, the ESA Kelvins filter), scored
  from the same out-of-fold predictions.
- The xlsx calls tier 0 "Safe". We map it to tier 0 and always display it as **"Below threshold"**.

## Method

**Inputs.** For each event, only its messages with `time_to_tca >= 2`, and only `event_id` plus the recommended
columns. `risk` is the label column: it is dropped before features are built (tested). Features per event:

- latest miss distance, log miss distance and the minimum so far; slopes over time of miss, log miss and
  `max_risk_estimate`; first-to-latest change in log miss distance
- latest, max and mean `max_risk_estimate`
- latest log chaser and target radial sigma, how much the chaser sigma shrank, and a placeholder-sigma flag
- relative speed, R/T/N position, F10, AP, object type
- message count, latest `time_to_tca`, time span
- rule tier at the latest message (`max_risk_estimate` + miss), miss-only tier, Pc-bound tier
- **the team nowcast** (`triage.model`) at the latest message: its tier and its demotion score. The nowcast is refit
  inside every split without that split's held-out events. The training events of each split get inner cross-fitted
  nowcast tiers (3 folds), so no event's nowcast was fit on that event.

**Model.** Two class-weighted `HistGradientBoostingClassifier`s, for P(final >= Elevated) and P(final >= Critical): a
cumulative ordinal model. scikit-learn does not support monotonic constraints for multiclass, and this form does.
Monotonic constraints: lower miss distance (latest and minimum) never lowers the risk, and a higher Pc bound or a higher
rule, miss, Pc-bound or nowcast tier never lowers it. Slopes are left free. Together the two give
P(final tier) = [below threshold, Elevated, Critical]. These are **scores of a class-weighted model**: they rank events
but overstate the rare tiers, so they are not calibrated probabilities.

**Bounded decision layer.** `predicted_final = max(floor, model escalation)`.

| Part | Rule |
|---|---|
| Floor | **Critical** if the latest >= 2 d message is Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km). **Never downgraded.** Otherwise the miss-distance tier, raised to the nowcast tier at that message. |
| Pc-only Elevated | An event Elevated only because of the Pc upper bound (miss > 5 km) keeps an Elevated floor unless the **existing constrained demoter** (`triage.model`, 99% recall target on truly-Elevated messages) removes it. We chose this over "left as is" because it is the same bounded logic the dashboard already shows: the forecast never shows a final tier below the event's current dashboard tier (the test nowcast matches `data/demo/events.json`'s tier on 2,167 of 2,167 events). "Left as is" is reported as an ablation (`bounded_rule_floor`): the same Critical recall with 2,635 false escalations instead of 1,139 on CV. |
| Escalate to Critical | P(final Critical) >= `t_crit`. `t_crit` is the loosest threshold that reaches **95% final-Critical recall** on out-of-fold scores of the training portion only. The 95% is a recall target, measured out of fold, not a guarantee. |
| Escalate to Elevated | P(final >= Elevated) >= `t_elev`. `t_elev` maximises F2 of "final >= Elevated" on the same out-of-fold scores. |
| Never | The model never lowers the floor and never advises a manoeuvre. |

Shipped thresholds (from the 5-fold out-of-fold scores of all 11,942 cohort events): `t_crit` = 0.054,
`t_elev` = 0.345.

**Decision record.** Every event gets one, in `predictions/test_final_tier.csv` and as `forecast` in
`data/demo/events.json`: the floor tier and the rule behind it, P(final tier), the thresholds, the decision
(`floor kept` / `escalated to Elevated` / `escalated to Critical`), and up to 3 plain-English reasons (for example
"Closing: miss distance fell from 1426 m to 601 m over 6 updates").

## Protocol

1. **Organisers' protocol first:** one seeded 80/20 event split (`random_state=0`), stratified by final tier.
2. **5-fold event CV** for stability (mean ± sd over folds; escalation counts summed over folds).
3. One row per event, so no event is ever split. Thresholds are chosen inside the training portion (inner 5-fold
   out-of-fold scores): nested. `test_data` outcomes are never used (there are none).
4. **Escalation:** final tier > true tier (`risk` + miss) at the latest >= 2 d message. "Caught" means predicted at or
   above the final tier. **False escalation:** predicted above the cutoff true tier, and the event did not escalate.
   Over-warning catches escalations for free, so the two columns are read together.

## Results

### Organisers' 80/20 split (validation: 2,389 events, 50 escalations)

| Method | Accuracy | Macro F1 | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|---|
| Always below threshold | 0.749 | 0.286 | 0.000 | 0.000 | 0.000 | 0/50 | 0 |
| Persistence: miss-only tier | **0.943** | **0.903** | 0.886 | **0.902** | **0.889** | 0/50 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.775 | 0.766 | 0.892 | 0.837 | 0.881 | 10/50 | 430 |
| Persistence: team nowcast tier | 0.900 | 0.857 | 0.892 | 0.837 | 0.881 | 6/50 | 129 |
| *Reference: `risk` + miss at latest >= 2 d (label column)* | *0.951* | *0.913* | *0.886* | *0.892* | *0.887* | *0/50* | *0* |
| Ablation: model argmax, no floor | 0.941 | 0.893 | 0.910 | 0.822 | 0.891 | 9/50 | 30 |
| **Second Look forecast (bounded)** | 0.871 | 0.781 | **0.970** | 0.579 | 0.854 | **24/50** | 218 |

### 5-fold event CV (11,942 events, 270 escalations; mean ± sd)

| Method | Accuracy | Macro F1 | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|---|
| Always below threshold | 0.749 ± 0.000 | 0.286 ± 0.000 | 0 | 0 | 0 | 0/270 | 0 |
| Persistence: miss-only tier | **0.938 ± 0.004** | **0.887 ± 0.012** | 0.865 ± 0.042 | **0.857 ± 0.029** | 0.863 ± 0.037 | 0/270 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.770 ± 0.012 | 0.754 ± 0.016 | 0.873 ± 0.041 | 0.808 ± 0.036 | 0.859 ± 0.036 | 40/270 | 2,135 |
| Persistence: team nowcast tier | 0.896 ± 0.010 | 0.846 ± 0.018 | 0.873 ± 0.041 | 0.808 ± 0.036 | 0.859 ± 0.036 | 27/270 | 616 |
| *Reference: `risk` + miss (label column)* | *0.946 ± 0.005* | *0.898 ± 0.013* | *0.866 ± 0.044* | *0.852 ± 0.029* | *0.863 ± 0.038* | *0/270* | *0* |
| Ablation: model argmax, no floor | 0.937 ± 0.005 | 0.885 ± 0.010 | 0.899 ± 0.047 | 0.803 ± 0.022 | **0.878 ± 0.036** | 49/270 | 177 |
| Ablation: bounded, Pc-only Elevated left as is | 0.737 ± 0.014 | 0.680 ± 0.010 | 0.950 ± 0.025 | 0.565 ± 0.013 | 0.835 ± 0.010 | 118/270 | 2,635 |
| **Second Look forecast (bounded)** | 0.862 ± 0.011 | 0.767 ± 0.011 | **0.950 ± 0.025** | 0.565 ± 0.013 | 0.835 ± 0.010 | **115/270** | 1,139 |

### Cost of the 95% Critical recall target (5-fold CV, shipped layer re-tuned train-only per target)

| Final-Critical recall target | Accuracy | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|
| 0.85 | 0.891 | 0.873 | 0.808 | 0.859 | 47/270 | 703 |
| 0.90 | 0.888 | 0.911 | 0.757 | **0.875** | 79/270 | 775 |
| **0.95 (shipped)** | 0.862 | **0.950** | 0.565 | 0.835 | **115/270** | 1,139 |

Moving from 90% to 95% recall catches 36 more escalations and about 4% more of the final-Critical events, but adds 364
false escalations and drops Critical precision from 0.76 to 0.57. 616 of the 1,139 false escalations already come from
the floor (the nowcast persistence row), before the model escalates anything. The 0.95 target was fixed before the run.
Picking 0.90 now would be a choice made after seeing CV, so we leave it to the team.

### Secondary cohort: Kalent's 8,293 events (same out-of-fold predictions)

| Method | Accuracy | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|
| Persistence: miss-only tier | **0.935** | 0.820 | **0.808** | **0.817** | 0/244 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.731 | 0.831 | 0.748 | 0.813 | 38/244 | 1,677 |
| **Second Look forecast (bounded)** | 0.847 | **0.935** | 0.508 | 0.800 | **104/244** | 801 |

These persistence rows match `docs/algorithm/algorithm.md` §2.4 (pooled there: 0.935 / 0.820 / 0.807 / 0.818, 0/244;
and 0.731, 38/244). Ours are fold means, so precision and F2 differ in the third decimal. The escalation counts are
identical, which confirms the escalation definition matches.

### What this says

- **The bar is persistence, and on accuracy, macro F1 and Critical F2 we do not beat it.** The miss-only tier at the
  latest 2-day message is the strongest single predictor (accuracy 0.938 on CV). The literature found the same
  (Kelvins, Neuraspace: `docs/algorithm/algorithm.md` §2.3).
- **What the bounded forecast buys:** Critical recall from 0.865 to **0.950** (CV), and **115 of 270** escalations
  caught where persistence catches none, with no rule-defined Critical ever lowered.
- **What it costs:** Critical precision falls from 0.857 to 0.565, accuracy from 0.938 to 0.862, and there are 1,139
  false escalations over 11,942 events. Over half of those false escalations (616) come from keeping Pc-only Elevated
  events at Elevated, which is the price of the never-silently-lower rule.
- The unbounded model (argmax, no floor) has the best Critical F2 (0.878) but can lower a rule-defined Critical, so it
  is not shipped.

## Test-set demo predictions (no outcomes, never scored)

2,167 test events. Floor: 1,365 below threshold, 606 Elevated, 196 Critical. Predicted final: 1,325 / 365 / 477, with
301 events escalated. The 477 predicted Critical events show the workload a 95% target implies.

## Limits

- **Few positives.** 270 escalations (50 in the 80/20 validation) and 834 final-Critical events. The Critical recall sd
  is ±0.025 to ±0.047 between folds.
- **Not calibrated.** `p_final` is a class-weighted score; the thresholds (0.054 for Critical) are low for that reason.
  Read it as a ranking, not a probability.
- **Recall target, not a guarantee.** The 95% is measured out of fold on events drawn like the training events (CV
  0.950 ± 0.025). It is not per event and will not carry over to a shifted live mix.
- **Easy cohort events.** 3,050 cohort events have their final message 2+ days out, so persistence is near-exact on
  them. The Kelvins cohort (final < 1 d) is the harder test, and there our Critical recall is 0.935.
- **Mission balance** (`mission_id`) is not controlled across folds, and `mission_id` is never an input.
- **Interaction with the action queue.** `triage/actions.py` has an optional forecast hook with placeholder thresholds
  (`forecast_p_maneuver` 0.5, `forecast_p_review` 0.2) that reads `forecast.p_final`. The stored `action` in
  `data/demo/events.json` was not recomputed. Rebuilding events with the hook on would move queues using uncalibrated
  scores, so calibrate it (or use `forecast.predicted_final_tier`) first.
