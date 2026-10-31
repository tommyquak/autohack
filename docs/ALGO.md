# Algorithm: conjunction risk triage

> **Status.** This is the shipped v1 model on `main`. A stronger v2 was tried and not shipped (§4, safety gate).
> Code: `triage/tiers.py`, `triage/data.py`, `triage/features.py`, `triage/train.py`,
> `triage/model.py`, `triage/explain.py`, `triage/evaluate.py`.

## 1. Problem and tiers

Each row of the dataset is a Conjunction Data Message (CDM): one update about a predicted close
approach between our satellite and another object, issued up to 7 days before the time of closest
approach (TCA). Several CDMs belong to one event (`event_id`). For every CDM we assign one of three
operational tiers, using the thresholds given in the challenge, which follow the NASA Conjunction
Assessment Handbook (NASA/SP-20205011318) and ESA Space Debris Office practice:

| Tier | Collision probability (Pc) | | Miss distance |
|---|---|---|---|
| 0 Below threshold | Pc < 1e-6 | and | > 5 km |
| 1 Elevated | 1e-6 <= Pc < 1e-4 | or | 1-5 km |
| 2 Critical | Pc >= 1e-4 | or | < 1 km |

**Precedence:** the worse of the Pc tier and the miss-distance tier wins.

The dataset column `risk` is log10(Pc), so the Pc thresholds are -6 and -4. `risk` is used **only
as the label** (to compute the true tier) and is never a model input. The allowed input columns
are: `time_to_tca`, `miss_distance`, `relative_speed`, `relative_position_r/t/n`,
`c_object_type`, `c_sigma_r`, `t_sigma_r`, `max_risk_estimate`, `F10`, `AP`.
`triage/data.py` drops every other column on load.

## 2. Pipeline

```
 CDM (allowed columns only)
   |
   v
 [1] Rule layer: tier = max( Pc tier of max_risk_estimate , miss-distance tier )
   |
   +-- Critical, or Elevated by miss distance (1-5 km) ----------------> keep (model never touches)
   +-- Covariance unusable (sigma sentinel) --------------------------> keep + needs_review
   +-- Below threshold -------------------------------------------------> keep
   |
   +-- Elevated ONLY because max_risk_estimate in [1e-6, 1e-4), miss > 5 km   (candidate)
         |
         v
       [2] Demotion classifier: p = P(true Pc >= 1e-6)
         |
         +-- p <  t        -> Below threshold
         +-- t <= p < 2t   -> Elevated + needs_review
         +-- p >= 2t       -> Elevated
   |
   v
 [3] Explanation layer (describes the tier, never changes it)
```

**[1] Rule layer (deterministic).** `max_risk_estimate` is an upper bound on Pc that is available
at prediction time. Taking the Pc tier of this upper bound and the miss-distance tier, and keeping
the worse, gives a conservative baseline that on the test set catches every Critical CDM, but
over-warns: many CDMs are shown as Elevated whose true Pc is below 1e-6.

**[2] Targeted demotion model.** The model is only allowed to act where the baseline over-warns,
and it can only lower a tier from Elevated to below threshold.

- *Candidates:* CDMs the baseline marks Elevated purely because `max_risk_estimate` is in
  [1e-6, 1e-4) while the miss distance is above 5 km, and whose covariance is usable. Everything
  else keeps its baseline tier. This keeps the model away from Critical CDMs, from the
  miss-distance rule, and from rows where a low Pc means "unknown" rather than "far apart".
- *Features:* the allowed columns plus physics-informed terms: log miss distance, log radial
  sigmas, miss distance divided by the combined radial sigma, the radial share of the relative
  position, and the margins of `max_risk_estimate` above the Elevated and Critical thresholds.
  Event-history features use **earlier CDMs of the same event only** (larger `time_to_tca`):
  update index, change in `max_risk_estimate` and in log miss distance since the previous CDM,
  and the running maximum of `max_risk_estimate`. Later CDMs are never seen.
- *Sigma sentinel:* when covariance is unusable, the dataset reports a placeholder radial sigma of
  63,781,360 m (10 Earth radii). Any sigma above 1e7 m is treated as missing in the features, and
  such rows are flagged as diluted: they are never candidates and are always marked
  `needs_review`.
- *Classifier:* scikit-learn `HistGradientBoostingClassifier` (300 iterations, learning rate 0.06,
  31 leaves, L2 1.0, balanced class weights, `c_object_type` as categorical). Monotonic
  constraints encode physical sense: predicted risk can only rise with `max_risk_estimate` and
  its two threshold margins, and only fall with miss distance and log miss distance.
- *Validation:* event-grouped 5-fold cross-validation (`GroupKFold` on `event_id`), so CDMs of one
  event never sit in both the training and the validation fold.
- *Threshold (recall target):* take the out-of-fold scores of the candidates that are
  truly Elevated and set the threshold `t` at their 1% quantile. This is a recall target, measured
  on out-of-fold scores (not a formal guarantee): about 99% of truly-Elevated candidates score at or
  above `t`, so on new events drawn like the training events, about 99% of them are expected to
  stay Elevated. The final model is then refit on
  all candidates and saved with `t`.

**needs_review and confidence.** A candidate that stays Elevated with a score below `2t` (close to
the cut) is flagged `needs_review`, as is every diluted row below Critical. Flagged rows keep the
higher tier: uncertainty only ever escalates attention, it never lowers a tier. `confidence` is
`1 - p` for a demoted candidate, `max(p, 0.5)` for a kept candidate, and the baseline value for
non-candidates (0.5 when `max_risk_estimate` is within half a decade of a Pc threshold,
otherwise 0.8), clipped to [0.5, 0.99].

**What needs_review means.** On a kept candidate, the `[t, 2t)` band marks a **close call** just
above the demotion bar. Close calls are mostly over-warnings, not the riskiest rows: on train
nested CV, 2.0% of kept candidates in the band are truly Elevated, against 32.1% for kept
candidates above `2t` (`scripts/review_errors.py` on `review/baseline`). The explanation and the
action queue therefore say "close call: near the demotion bar, likely over-warning; analyst can
clear". On placeholder-sigma, diluted or missing-input rows, `needs_review` instead means the input
can't be trusted; on test, 61 of the 84 needs-review events also carry `no_covariance`. Tiers and
the `needs_review` field itself are unchanged by this wording.

**What can never happen**
- A Critical CDM (by Pc upper bound or by miss < 1 km) is never demoted.
- A CDM that is Elevated by miss distance (1-5 km) is never demoted.
- A diluted / sigma-sentinel row is never demoted.
- The model's only possible action is Elevated -> below threshold on a candidate, and
  `needs_review` never lowers a tier.
- If no trained model is present, the system falls back to the rule layer alone.

## 3. Explanation layer

`triage/explain.py` produces a short operator-facing explanation per event. The tier always comes
from the pipeline above; this layer only describes it.

- **Structured facts only.** A fixed set of facts is built from fields already in
  `reports/events.json` (tier, rules fired, time to TCA, miss distance, Pc upper bound, trend
  across updates, cautions). Claude is asked to reword these facts in 3-5 sentences, use only
  numbers that appear in them, and not recommend or rule out a manoeuvre.
- **Template fallback.** With no API key, an API error, a timeout, or an incomplete response, a
  deterministic template built from the same facts is returned. The response records whether the
  text came from `claude` or `template`, so the demo never depends on the API.
- **Wording guardrail.** Tier 0 is always "below threshold". Any Claude output containing "safe",
  "safely" or "safety" is rejected and replaced by the template.
- **Cautions.** *No covariance:* if a sigma is at the dataset's ceiling value, the text says the Pc
  estimate should not be relied on by itself and that the miss-distance rule still applies.
  *Probability dilution:* if the combined radial sigma exceeds miss distance / sqrt(2) and the
  event is not Critical by Pc, the text warns that a low Pc may reflect poor tracking rather than
  real separation. *Needs review* is repeated in plain words: on a kept Pc-only Elevated candidate
  as "close call: near the demotion bar, likely over-warning; analyst can clear", otherwise as an
  input that is missing or unreliable (`triage.explain.review_kind`).

## 4. Evaluation

Baselines (`triage/evaluate.py`): majority class, miss-distance rule alone, and the
`max_risk_estimate` rule (layer [1] above). All metrics are on the held-out test set
(24,484 CDMs); the model never saw these events.

| Method | Critical recall | False Elevated | Flagged (workload) | Under-tiered | Macro F1 |
|---|---|---|---|---|---|
| `max_risk_estimate` rule (baseline) | 100% | 4,526 | 54.2% | 0 | 0.841 |
| **Model** | **100%** | **2,206 (-51%)** | **44.7%** | **1 CDM** | **0.910** |

"False Elevated" counts truly-below-threshold CDMs shown as Elevated. EVAL.md's "false alarms"
(4,534 / 2,214) also counts 8 CDMs whose Pc bound is ≥ 1e-4 (shown Critical, never demoted) but
whose true tier is below threshold.

The model halves the false Elevated alerts and cuts the share of CDMs an operator must look at
from 54.2% to 44.7%, while preserving every rule-defined Critical. Two measurements of the price:
at event level, all 288 events it removes from the queue were truly below threshold at their latest
update; at message level, one genuinely Elevated CDM (event 1278) is shown below threshold. We keep
it as our documented failure case rather than hide it.

**Stronger baselines** (full table in [EVAL.md](EVAL.md)). The untuned rule "miss-distance rule +
Pc bound for Critical only" has 100% Critical recall, 8 false alarms and 31.5% flagged, but shows
1,012 truly-Elevated test CDMs as below threshold. "Pc bound OR miss < 1 km" is worse (4,534 false
alarms, 1,693 under-tiered). On train CV only, a Pc-bound threshold tuned with the same 99% rule
removes 9.7% of false alarms; the model removes 64.1%. The miss rule's macro F1 is flattering by
construction: miss distance is half of the label, so it can never raise a false alarm.

**Safety gate.** We fixed the gate "no more under-tiered test CDMs than v1's 1" before testing v2
and stuck to it: v2 cut test false alarms by a further 23% (2,214 → 1,694) but under-tiered 3, so
v1 ships. That gate was set on test, where under-tier counts are noisy: v1's CV rate (39 on train)
predicts about 5.9 on test, so seeing ≤ 1 had about a 2% chance. The stricter, honest gate is
operator-invisible under-tier on nested CV (not `needs_review`, and no later CDM of the event shown
at or above its true tier): v1 has 23 CDMs in 10 events. v2 as tested (0.992) has 33 under-tiered
and 20 invisible on CV. At 0.995, v2 has the same workload (+1.1% false alarms), 17 under-tiered
and 9 invisible: it halves under-tiering. That is our next step, not shipped, and never run on test.

**A failed first attempt.** Our first model regressed log Pc directly and tiered the prediction.
The evaluation showed it flagged 100% of CDMs, i.e. no reduction in workload at all. That is why
the final design keeps the rules as the backbone and lets a classifier act only on one narrow,
well-defined slice.

**Known limits**
- No test CDM is within 2 days of TCA, so performance in the final, most important window is
  untested.
- 63 test events have a placeholder sigma (no usable covariance). These are never demoted and are
  flagged for review, but their Pc carries little information.
- The 99% is a recall target, measured on out-of-fold scores (not a formal guarantee). It holds for
  events like those in training, and not per event.
- "Critical recall by construction" relies on `max_risk_estimate` being an upper bound. True risk
  exceeds it in 101 test CDMs, by at most 0.04 decade (564 train CDMs, at most 0.14 decade); none
  crosses a tier line, so the Critical recall by construction holds on this data.
- The `needs_review` band on candidates marks close calls (mostly over-warnings), not the riskiest
  Elevated rows; ranking the Elevated queue by a calibrated probability is future work.

**Reproduce:** `uv run python -m triage.train` then `uv run python -m triage.evaluate`
(writes `reports/metrics.json`).

## 5. Forecast extension (in progress)

Everything above is a **nowcast**: the tier of each CDM when it arrives. A separate per-event **forecast** is being
built on top of it. From an event's CDMs at least 2 days before TCA, it predicts the tier the event will end at. This
targets the first known limit above: no test CDM is within 2 days of TCA, so the 24 h panel is empty.

It reuses `triage/tiers.py` and the same allowed columns, and `risk` stays label-only. It does not change `predict()`
or the pipeline in this document.

- Design, evidence and status: [`docs/algorithm/algorithm.md`](algorithm/algorithm.md) (owner: Algorithms forecast,
  Kalent).
- Checks of its numbers against the data: [`docs/algorithm/VERIFICATION.md`](algorithm/VERIFICATION.md).

## 6. Event action queue

`triage/actions.py` turns each event's tier, cautions and trend into one queue (MANEUVER PLANNING / ANALYST REVIEW /
MONITOR). Rules, train-protocol results against persistence, and limits: [`docs/actions.md`](actions.md).
