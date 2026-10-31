# Final-tier forecast (the organisers' official task)

**Task** (organisers' `challenge1_event_labels.xlsx`, sheet `data_notes`): predict each event's **final** tier (its last
message before closest approach) using **only messages with `time_to_tca >= 2` days**. Evaluate by splitting
`train_data` by `event_id` (for example 80/20), never splitting an event. `test_data` has no final outcomes, so it gets
demo predictions only.

Code: `triage/forecast_features.py` (labels, the 2-day cut, event features), `triage/forecast.py` (model, bounded
decision layer, evaluation, outputs). Run: `uv run python -m triage.forecast` (about 15 min the first time, because it
refits the nowcast for every split; cached in `reports/forecast_cache/` after that, keyed by a hash of the nowcast's
code (`triage/model.py`, `train.py`, `features.py`, `tiers.py`, `data.py`, `forecast_features.py`), the training data
and the split's event ids, so a code, label or data change is a cache miss, never a silent reuse). Then
`uv run python scripts/export_final_tier_xlsx.py` rebuilds `predictions/test_final_tier_predictions.xlsx` from the CSV. Every number below comes from
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

**Model.** Two class-weighted `HistGradientBoostingClassifier`s, for score(final >= Elevated) and score(final >= Critical): a
cumulative ordinal model. scikit-learn does not support monotonic constraints for multiclass, and this form does.
Monotonic constraints: lower miss distance (latest and minimum) never lowers the risk, and a higher Pc bound or a higher
rule, miss, Pc-bound or nowcast tier never lowers it. Slopes are left free. The two outputs are **scores
(class-weighted, not calibrated)**: they rank events but overstate the rare tiers, so they are never shown or used as
probabilities. They appear only inside a score-vs-threshold comparison.

**Bounded decision layer.** `predicted_final = max(floor, model escalation)`.

| Part | Rule |
|---|---|
| Floor | **Critical** if the latest >= 2 d message is Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km). **Never downgraded.** Otherwise the miss-distance tier, raised to the nowcast tier at that message. |
| Pc-only Elevated | An event Elevated only because of the Pc upper bound (miss > 5 km) keeps an Elevated floor unless the **existing constrained demoter** (`triage.model`, 99% recall target on truly-Elevated messages) removes it. We chose this over "left as is" because it is the same bounded logic the dashboard already shows: the forecast never shows a final tier below the event's current dashboard tier (the test nowcast matches `data/demo/events.json`'s tier on 2,167 of 2,167 events). "Left as is" is reported as an ablation (`bounded_rule_floor`): the same Critical recall with 2,310 false escalations instead of 775 on CV. |
| Escalate to Critical | score(final Critical) >= `t_crit`. `t_crit` is the **highest** threshold that still reaches **90% final-Critical recall** (the fewest escalations that meet the target) on out-of-fold scores of the training portion only. The 90% is a recall target, measured out of fold, not a guarantee. The team chose 0.90 over the original 0.95 after seeing the CV sensitivity below (0.85 and 0.95 are kept as sensitivity rows). |
| Escalate to Elevated | score(final >= Elevated) >= `t_elev`. `t_elev` maximises F2 of "final >= Elevated" on the same out-of-fold scores. |
| Never | The model never lowers the floor and never advises a manoeuvre. |

Shipped thresholds (from the 5-fold out-of-fold scores of all 11,942 cohort events): `t_crit` = 0.585,
`t_elev` = 0.345. **They are not stable across folds:** `t_crit` ranges 0.425-0.682 and `t_elev` 0.277-0.665 over the
5 CV training portions (0.516 and 0.510 on the 80/20 split). The two-line baseline's thresholds barely move
(Critical line 1,044-1,137 m, Elevated line 5,179-5,507 m; 1,108 m and 5,406 m on all events).

**Decision record.** Every event gets one, in `predictions/test_final_tier.csv` and as `forecast` in
`data/demo/events.json`: the floor tier and the rule behind it, the decision (`floor kept` / `escalated to Elevated` /
`escalated to Critical`), for an escalation the one comparison behind it (`escalation`: which score, its value and the
threshold), the two scores labelled as uncalibrated ranking scores, `"calibrated": false`, and up to 3 plain-English
reasons (for example "Closing: miss distance fell from 1426 m to 601 m over 6 updates"). There is no probability field:
`p_final` was removed so no view can show a score as "P". When a Pc-only Elevated floor stayed because an input was
missing or invalid, the reason says so ("the constrained demoter was not allowed to lower it") instead of "the demoter
kept it". `triage.build_events` re-attaches the forecast from the CSV after a rebuild of `events.json`, and refuses
(with a message) when the CSV covers other events or its floor no longer equals the rebuilt tier (a stale forecast).

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
| Persistence: miss-only tier (keep today's tier) | **0.943** | **0.903** | 0.886 | **0.902** | 0.889 | 0/50 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.775 | 0.766 | 0.892 | 0.837 | 0.881 | 10/50 | 430 |
| Persistence: team nowcast tier | 0.900 | 0.857 | 0.892 | 0.837 | 0.881 | 6/50 | 129 |
| *Reference: `risk` + miss at latest >= 2 d (label column)* | *0.951* | *0.913* | *0.886* | *0.892* | *0.887* | *0/50* | *0* |
| Ablation: model argmax, no floor | 0.941 | 0.893 | 0.910 | 0.822 | 0.891 | 9/50 | 30 |
| Rule: floor + Critical if latest miss <= m* (one line, no model) | 0.895 | 0.844 | **0.934** | 0.768 | **0.896** | 13/50 | 147 |
| Rule: floor + Critical line + Elevated line (two lines, no model) | 0.887 | 0.838 | **0.934** | 0.768 | **0.896** | **18/50** | 172 |
| Ablation: Critical line + model for Elevated | 0.896 | 0.846 | **0.934** | 0.768 | **0.896** | 17/50 | 148 |
| Ablation: bounded, Pc-only Elevated left as is | 0.773 | 0.757 | 0.910 | 0.788 | 0.883 | 16/50 | 443 |
| **Second Look forecast (bounded, 90% target)** | 0.897 | 0.848 | **0.910** | 0.788 | 0.883 | 13/50 | 142 |

### 5-fold event CV (11,942 events, 270 escalations; mean ± sd)

| Method | Accuracy | Macro F1 | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|---|
| Always below threshold | 0.749 ± 0.000 | 0.286 ± 0.000 | 0 | 0 | 0 | 0/270 | 0 |
| Persistence: miss-only tier (keep today's tier) | **0.938 ± 0.004** | **0.887 ± 0.012** | 0.865 ± 0.042 | **0.857 ± 0.029** | 0.863 ± 0.037 | 0/270 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.770 ± 0.012 | 0.754 ± 0.016 | 0.873 ± 0.041 | 0.808 ± 0.036 | 0.859 ± 0.036 | 40/270 | 2,135 |
| Persistence: team nowcast tier | 0.896 ± 0.010 | 0.846 ± 0.018 | 0.873 ± 0.041 | 0.808 ± 0.036 | 0.859 ± 0.036 | 27/270 | 616 |
| *Reference: `risk` + miss (label column)* | *0.946 ± 0.005* | *0.898 ± 0.013* | *0.866 ± 0.044* | *0.852 ± 0.029* | *0.863 ± 0.038* | *0/270* | *0* |
| Ablation: model argmax, no floor | 0.937 ± 0.005 | 0.885 ± 0.010 | 0.899 ± 0.047 | 0.803 ± 0.022 | **0.878 ± 0.036** | 49/270 | 177 |
| Rule: floor + Critical if latest miss <= m* (one line, m* 1.04-1.14 km, no model) | 0.892 ± 0.011 | 0.835 ± 0.018 | 0.897 ± 0.044 | 0.755 ± 0.036 | 0.864 ± 0.032 | 47/270 | 687 |
| Rule: floor + Critical line + Elevated line (two lines, Elevated 5.18-5.51 km, no model) | 0.888 ± 0.012 | 0.832 ± 0.018 | 0.897 ± 0.044 | 0.755 ± 0.036 | 0.864 ± 0.032 | 73/270 | 766 |
| Ablation: Critical line + model for Elevated | 0.887 ± 0.012 | 0.831 ± 0.016 | 0.897 ± 0.044 | 0.755 ± 0.036 | 0.864 ± 0.032 | 67/270 | 774 |
| Ablation: bounded, Pc-only Elevated left as is | 0.761 ± 0.014 | 0.743 ± 0.016 | **0.911 ± 0.050** | 0.757 ± 0.036 | 0.875 ± 0.037 | **100/270** | 2,310 |
| **Second Look forecast (bounded, 90% target)** | 0.888 ± 0.012 | 0.834 ± 0.017 | **0.911 ± 0.050** | 0.757 ± 0.036 | 0.875 ± 0.037 | 79/270 | 775 |

All rows share the folds, the floor and train-only threshold choice: m* and the lines are tuned on each training
portion for the same 90% target, and the Elevated line maximises F2 like `t_elev`.

**Does the model beat a distance rule?** Barely, and not everywhere. Against the strongest rule-only baseline (two
miss-distance lines, no model), the forecast has higher Critical F2 in 5 of 5 CV folds, but by +0.002 to +0.022 (mean
+0.011, about a third of the between-fold sd). Critical recall is +0.014 (760 vs 748 of 834 final-Critical events
found) and Critical precision +0.002, for 6 more escalations caught (79 vs 73) and 9 more false escalations (775 vs
766). On the 80/20 split the rules win (Critical F2 0.896 vs 0.883, 18 vs 13 escalations caught). In the 8,293-event
cohort the forecast catches 5 more escalations for 24 more false ones, at lower Critical precision (0.699 vs 0.717).
Using the model only for Elevated escalation is worse than the Elevated line (67 vs 73 caught, 774 vs 766 false). At
the original 0.95 target the two lines beat the model outright (Critical F2 0.851 vs 0.835, precision 0.610 vs 0.565,
1,031 vs 1,139 false escalations, 114 vs 115 caught). So the model's measurable value over two distance lines is a
small, consistent Critical-recall gain at 0.90. The team keeps the model at 0.90; the two-line rule is the fallback,
simpler to inspect and with stable thresholds. Paired per-fold differences: `decision_layer.paired_vs_two_lines_cv`.

**Confusion matrix, Second Look forecast (5-fold CV, pooled over folds; rows true final tier, columns predicted):**

| True final \ predicted | Below threshold | Elevated | Critical |
|---|---|---|---|
| Below threshold | 8,019 | 900 | 27 |
| Elevated | 119 | 1,824 | 219 |
| Critical | 10 | 64 | 760 |

Persistence (miss-only), same layout: `[[8748, 179, 19], [327, 1733, 102], [14, 99, 721]]`. The forecast moves 39
final-Critical events from under-tiered to Critical (721 → 760) and leaves 10 shown as below threshold (14 for
persistence). The 80/20 validation confusion is `[[1619, 167, 4], [22, 373, 37], [2, 13, 152]]`.

### Recall-target sensitivity (5-fold CV, shipped layer re-tuned train-only per target)

| Final-Critical recall target | Accuracy | Critical R | Critical P | Critical F2 | Escalations caught | False escalations | Two lines, no model (F2; caught; false) |
|---|---|---|---|---|---|---|---|
| 0.85 | **0.891** | 0.873 | **0.808** | 0.859 | 47/270 | **703** | 0.859; 53/270; 695 |
| **0.90 (shipped)** | 0.888 | 0.911 | 0.757 | **0.875** | 79/270 | 775 | 0.864; 73/270; 766 |
| 0.95 | 0.862 | **0.950** | 0.565 | 0.835 | **115/270** | 1,139 | 0.851; 114/270; 1,031 |

The team chose 0.90: it has the best Critical F2 of the three and is above miss-only persistence (0.875 vs 0.863),
with 364 fewer false escalations than 0.95 (775 vs 1,139) and Critical precision 0.757 instead of 0.565. The cost is
36 fewer escalations caught (79 vs 115) and lower Critical recall (0.911 vs 0.950). The choice was made after seeing
these CV numbers; the original pre-registered target was 0.95.

### Secondary cohort: Kalent's 8,293 events (same out-of-fold predictions): the guide for the test demo

| Method | Accuracy | Critical R | Critical P | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|
| Persistence: miss-only tier | **0.935** | 0.820 | **0.808** | 0.817 | 0/244 | 0 |
| Persistence: `max_risk_estimate` + miss | 0.731 | 0.831 | 0.748 | 0.813 | 38/244 | 1,677 |
| Rule: floor + one Critical miss line (no model) | 0.882 | 0.865 | 0.717 | 0.829 | 43/244 | 431 |
| Rule: floor + two miss lines (no model) | 0.878 | 0.865 | 0.717 | 0.829 | 67/244 | 495 |
| **Second Look forecast (bounded, 90% target)** | 0.876 | **0.883** | 0.699 | **0.837** | **72/244** | 519 |

These persistence rows match `docs/algorithm/algorithm.md` §2.4 (pooled there: 0.935 / 0.820 / 0.807 / 0.818, 0/244;
and 0.731, 38/244). Ours are fold means, so precision and F2 differ in the third decimal. The escalation counts are
identical, which confirms the escalation definition matches. In this cohort the final message is never among the
inputs, so it is the better guide to the test set (see below).

### What this says

- **We do not beat persistence across the board.** The forecast wins on Critical recall (0.911 vs 0.865), Critical F2
  (0.875 vs 0.863) and escalations caught (79 of 270 vs 0), and loses on accuracy (0.888 vs 0.938), macro F1 (0.834
  vs 0.887) and Critical precision (0.757 vs 0.857). The miss-only tier at the latest 2-day message is the strongest
  single predictor. The literature found the same (Kelvins, Neuraspace: `docs/algorithm/algorithm.md` §2.3).
- **Two distance lines do almost as well as the model.** Escalating to Critical when the latest miss is at or under a
  tuned line (about 1.1 km) and to Elevated at or under about 5.4 km reaches Critical recall 0.897, precision 0.755,
  F2 0.864, 73/270 escalations caught and 766 false. The model adds +0.011 Critical F2 and 6 caught escalations for 9
  more false ones on CV, and loses on the 80/20 split. Do not pitch the model as beating a rule.
- **What it costs:** 775 false escalations over 11,942 events. 616 of them come from the floor alone (the nowcast
  persistence row: keeping Pc-only Elevated events at Elevated), which is the price of the never-silently-lower rule.
- The unbounded model (argmax, no floor) has the best Critical F2 (0.878) but can lower a rule-defined Critical, so it
  is not shipped.

## Test-set demo predictions (no outcomes, never scored)

2,167 test events. Floor: 1,365 below threshold, 606 Elevated, 196 Critical. Predicted final: 1,343 / 569 / 255, with
81 events escalated (59 Elevated to Critical, 22 below threshold to Elevated). **Expected queue: the forecast marks 255
of 2,167 test events Critical, against 196 by rule** (it was 477 at the 0.95 target). At the 8,293-event cohort's
Critical precision (0.699), about 178 of those 255 would end Critical. The two-line rule would mark 209 Critical
(1,342 / 616 / 209). Test events' latest message is mostly 2.0-2.4 days out (89% of events, median 2.19 d),
so their final message is never among the inputs. That matches the 8,293-event cohort above (final message < 1 day),
which is the better guide to how the forecast behaves on test than the 11,942-event CV.

## Limits

- **Few positives.** 270 escalations (50 in the 80/20 validation) and 834 final-Critical events. The Critical recall sd
  is ±0.044 to ±0.050 between folds.
- **Scores (class-weighted, not calibrated).** The two scores are class-weighted, not probabilities. Read them as a
  ranking; the thresholds (`t_crit` 0.585, `t_elev` 0.345) only make sense on that scale, and they move a lot between
  folds (above). Views show the decision, the floor and the score-vs-threshold comparison, never a "P".
- **Recall target, not a guarantee.** The 90% is measured out of fold on events drawn like the training events (CV
  0.911 ± 0.050). It is not per event and will not carry over to a shifted live mix.
- **Chosen after seeing CV.** 0.90 was picked from the sensitivity table, so the CV numbers at 0.90 are slightly
  optimistic as an estimate of a pre-registered choice.
- **Easy cohort events.** 3,050 cohort events have their final message 2+ days out, so persistence is near-exact on
  them. The Kelvins cohort (final < 1 d) is the harder test, and there our Critical recall is 0.883.
- **Mission balance** (`mission_id`) is not controlled across folds, and `mission_id` is never an input.
- **Interaction with the action queue.** `triage/actions.py` has an optional forecast hook with placeholder thresholds
  (`forecast_p_maneuver` 0.5, `forecast_p_review` 0.2). It now acts only on a forecast marked `"calibrated": true`.
  This forecast is `"calibrated": false` and has no `p_final`, so it never moves a queue. The stored `action` in
  `data/demo/events.json` is unchanged.
