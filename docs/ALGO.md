# Algorithm: conjunction risk triage

> **Status.** The model described here lives in PR #3 (`feat/model`), not yet merged into `main`.
> A v2 is being trialled; this document will be updated if it ships.
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
- *Threshold (split-conformal style):* take the out-of-fold scores of the candidates that are
  truly Elevated and set the threshold `t` at their 1% quantile. By construction about 99% of
  truly-Elevated candidates score at or above `t`, so on new events drawn like the training
  events, at least 99% of them are expected to stay Elevated. The final model is then refit on
  all candidates and saved with `t`.

**needs_review and confidence.** A candidate that stays Elevated with a score below `2t` (close to
the cut) is flagged `needs_review`, as is every diluted row below Critical. Flagged rows keep the
higher tier: uncertainty only ever escalates attention, it never lowers a tier. `confidence` is
`1 - p` for a demoted candidate, `max(p, 0.5)` for a kept candidate, and the baseline value for
non-candidates (0.5 when `max_risk_estimate` is within half a decade of a Pc threshold,
otherwise 0.8), clipped to [0.5, 0.99].

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
  real separation. *Needs review* is also repeated in plain words.

## 4. Evaluation

Baselines (`triage/evaluate.py`): majority class, miss-distance rule alone, and the
`max_risk_estimate` rule (layer [1] above). All metrics are on the held-out test set
(24,484 CDMs); the model never saw these events.

| Method | Critical recall | False Elevated | Flagged (workload) | Under-tiered | Macro F1 |
|---|---|---|---|---|---|
| `max_risk_estimate` rule (baseline) | 100% | 4,526 | 54.2% | 0 | 0.841 |
| **Model** | **100%** | **2,206 (-51%)** | **44.7%** | **1 CDM** | **0.910** |

The model halves the false Elevated alerts and cuts the share of CDMs an operator must look at
from 54.2% to 44.7%, while still catching every Critical CDM. The price is one CDM shown at a
lower tier than its truth; we keep it as our documented failure case rather than hide it.

**A failed first attempt.** Our first model regressed log Pc directly and tiered the prediction.
The evaluation showed it flagged 100% of CDMs, i.e. no reduction in workload at all. That is why
the final design keeps the rules as the backbone and lets a classifier act only on one narrow,
well-defined slice.

**Known limits**
- No test CDM is within 2 days of TCA, so performance in the final, most important window is
  untested.
- 63 test events have a placeholder sigma (no usable covariance). These are never demoted and are
  flagged for review, but their Pc carries little information.
- The 99% recall target holds for events like those in training; it is not a per-event guarantee.

**Reproduce:** `uv run python -m triage.train` then `uv run python -m triage.evaluate`
(writes `reports/metrics.json`).
