# Review: can Second Look beat the baselines further, safely, before the 15:00 freeze?

Reviewer: Claude (for Tommy) · 31 Oct 2026, 12:37-12:55 · branch `review/baseline` · nothing merged.

**Method.** Every model number below is train-only, nested, event-grouped 5-fold CV of the shipped v1 pipeline
(`scripts/review_oof.py`): each outer fold refits `triage.train.train`, inner-fold threshold included, and
predicts held-out events with `triage.model.predict_with` plus `predict()`'s untrusted-input floor. It reproduces the
v2 branches' v1 row (false alarms 10,049 → 10,056 with the 7-row input floor; under-tier 39). The only numbers taken
from test are the **untuned** rules in §6. They are fixed rules written from the brief, so scoring them is a baseline,
not tuning. `risk` is used only as the label, and only `FEATURES` are used as inputs. Raw output for every table is in
`reports/review_*.txt` (gitignored) and can be regenerated with the scripts.

"Test-equivalent" means CV count × 24,484 / 162,634 = × 0.1505.

## Ranked recommendations (impact × confidence ÷ time)

| # | Change | Expected effect (train CV) | Safety-gate risk | Time | Before 15:00? |
|---|---|---|---|---|---|
| 1 | **Add two baselines to EVAL.md / README:** "miss rule + Pc bound for Critical only" (untuned, test) and "Pc bound with a tuned threshold" (CV) | Answers the judge question "is the model better than a tuned rule?" On CV, v1 removes **64%** of false alarms. The best tuned 1-parameter rule removes **9.7%** and has *more* under-tier (47 vs 39). | None (docs) | 20 min | **Yes** |
| 2 | **Restate the safety gate on CV, not test.** "≤ 1 under-tiered test CDM" is a 2% fluke for v1 itself | v1's CV rate predicts ~5.9 under-tiered test CDMs, so P(≤ 1) ≈ 0.02. v2 predicts ~5.0 and showed 3. Choosing between them on this number is model selection on test noise. Proposed gate: *invisible* under-tier on nested CV, with v1 as the bar (23 CDMs / 10 events). | None (docs); it makes the gate stricter and more honest | 20 min | **Yes** |
| 3 | **Replace `confidence` with a calibrated P(truly Elevated) for demotion candidates** (display and ranking only), and rename the candidate `needs_review` band | `confidence` ECE is **0.218**. Cross-fitted isotonic P has ECE **0.002**, and Brier drops from 0.067 to 0.057. Among kept candidates, the bottom fifth is 2.9% truly Elevated and the top fifth 74.6%. The `needs_review` band holds **2.0%** truly Elevated, against 32.1% for the rest, so today "needs review" marks the *least* risky Elevated rows. | None: no tier changes | 45 min (fit isotonic on train.py's existing OOF scores, save it in the artifact, add an optional field) | **Yes** if the field is optional. Otherwise do just the relabel. |
| 4 | **Label the basis of each Critical: "Critical by Pc bound only (miss ≥ 1 km)"** as a deterministic fact. Do **not** ship an ML "likely over-warned" flag yet. | On train, 73.4% of Pc-only Criticals are truly below 1e-4 (899 / 1,224). An ML flag reaches **95.8%** precision at 30% recall, but it still labels **12 truly-Critical CDMs in 3 events** "likely over-warned", even at the strictest threshold. | Deterministic label: none. ML flag: real (it would soften a true Critical) | 15 min (label) / post-freeze (flag) | Label **yes**. Flag **no**. |
| 5 | **v2 (stronger) is a CV Pareto improvement. Ship it at a stricter recall target, decided by the CV gate, not test.** | See §4. Against v1's 10,049 false alarms / 39 under-tier / 23 invisible in 10 events: **v2@0.995 has the same workload (10,163 false alarms, +1.1%) with 17 under-tier and 9 invisible in 2 events.** v2@0.997 has 10,830 (+7.8%), 8 under-tier and 1 invisible. v2@0.992 has 9,185 (−8.6%), 33 and 20 / 7. | Medium. It is a model swap, and `git merge-tree` shows conflicts with main in 5 core files (`model.py`, `train.py`, `features.py`, `data.py`, tests), including main's robustness floor. 0.995 has never been run on test, so it needs one pre-registered test run, reported whatever it shows (expect ~2.6 under-tiered CDMs). | 90 min (port, robustness eval back to 26/26, one test run, Kalent signs off) | **Post-freeze by default.** Before 15:00 only if one person owns it from 13:15 and it is green by 14:15. |
| 6 | **Do not change the v1 threshold or add event-persistence post-processing** | Every v1 recall target lies on one frontier: more false-alarm removal costs under-tier (§4). Persistence rules are dominated by simply raising the target. | — | 0 | No change |

Action queue (PR #39) was merged during this review (`ef533a9`). §5 has notes on it, and no change is recommended.

## 1. Error anatomy of the remaining false alarms (train CV)

v1 leaves **10,056** false alarms on CV (~1,514 test-equivalent; the test set itself has 2,214, see the note on lead time below).

| Cause | CDMs | Share |
|---|---|---|
| Candidate kept Elevated, score ≥ 2t | 8,287 | 82.4% |
| Candidate kept, score in [t, 2t) (already `needs_review`) | 1,743 | 17.3% |
| Placeholder sigma (never a candidate) | 19 | 0.2% |
| Pc bound ≥ 1e-4 (Critical, never touched) | 7 | 0.1% |

- **99.7% come from one place:** Pc-bound-Elevated candidates that the classifier keeps. Rules contribute almost
  nothing, so any further gain has to come from the demoter.
- **Just above a threshold:** 1,043 sit within 1.5× of the demotion cut and 1,736 within 2×. 2,653 have a Pc bound
  within 0.25 decade of 1e-6. These are not "nearly right" in truth, though: their true Pc is spread from −30 (1,012 on
  the floor) to −6.5 (1,491).
- **Most are far from the cut.** 4,998 score more than 10× t. These look Elevated to the model: median Pc bound −5.48,
  against −5.22 for truly Elevated.
- **Lead time drives it.** False alarms are 42.6% of candidates at 4-7 days to TCA, 27.1% at 2-4 days, 17.3% at 1-2
  days and 12.4% at 0-1 day. The test set has only CDMs at 2 days or more. On CV restricted to ≥ 2 days, v1 removes
  57.0% of false alarms, against 64.1% overall. That matches test's 51%, so the test gap is mostly lead-time mix, not
  overfitting.
- **Miss and sigma:** false alarms spread across 5-50 km of miss (median 11.8 km) and 10-500 m of combined radial sigma.
  Truly-Elevated candidates have about 2× the median `c_sigma_r` (175 m vs 87 m). This is consistent with dilution
  behaviour, which the classifier already exploits.
- **Under-tier anatomy:** 39 CDMs in 17 events (~5.9 test-equivalent). True Pc of every one lies in [10^−5.99, 10^−5.01],
  with 23 of the 39 within 0.15 decade of 1e-6. All are demotions with score/threshold between 0.08 and 0.98.

## 2. The over-tiered Criticals (165 + 8 on test): a safe "likely over-warned" flag?

Population: Critical only because the Pc bound is ≥ 1e-4, miss ≥ 1 km, usable covariance. Train: 1,224 CDMs in
241 events; 899 (73.4%) are truly below Critical (892 Elevated, 7 below threshold). The tier always stays Critical.

| Flag (nested event-grouped CV, train) | Flagged | Precision (truly over-warned) | Recall of over-warned | Truly Critical flagged | Events with a wrong flag |
|---|---|---|---|---|---|
| No flag (base rate) | 1,224 | 73.4% | 100% | 325 | 88 |
| Rule: miss > 5 km | 80 | 63.8% | 5.7% | 29 | 12 |
| Rule: bound < 10^−3.5 | 972 | 80.7% | 87.2% | 188 | 65 |
| Model, threshold below every inner-fold true-Critical score | 216 | 94.4% | 22.7% | 12 | 3 |
| Model, ≤ 1% of true-Critical flagged (inner folds) | 286 | 95.8% | 30.5% | 12 | 3 |
| Model, ≤ 5% | 459 | 96.7% | 49.4% | 15 | 6 |

**Verdict.** The best simple rule is worse than the base rate's own message, and the ML flag is good but not safe. The
same 3 events produce wrong flags at every threshold, which suggests events the model cannot separate from these
inputs. With ~48 events per fold, the conformal bound is too loose to promise anything. Before 15:00, show the
deterministic fact, "Critical by Pc bound only; miss distance X km", and the train base rate (73% of such CDMs had a
true Pc below 1e-4) as context, worded so it never reads as a demotion. The ML flag is post-freeze work and needs more
Pc-only Critical events than this dataset has.

## 3. Is `confidence` meaningful?

No. Reliability on CV (`confidence` against "shown tier = true tier"):

| `confidence` bin | CDMs | Mean confidence | Observed accuracy |
|---|---|---|---|
| 0.50 (constant for near-threshold rule rows *and* most kept candidates) | 54,334 | 0.50 | 0.83 |
| 0.80 (constant for other rule rows) | 86,436 | 0.80 | 0.99 |
| 0.95-0.99 (demoted candidates) | 19,402 | 0.99 | 0.99 |

ECE is 0.218. Non-candidate confidences are constants (0.5 / 0.8) that understate true accuracy (0.98 / 0.999). Kept
candidates mostly get 0.5 although only 11% of them are truly Elevated. The raw classifier score (balanced class
weights) is over-confident above 0.2: in the 0.8-0.9 bin, 0.53 are truly Elevated. Cross-fitted isotonic calibration
(by outer fold, so no event calibrates itself) gives ECE 0.002.

**Would a calibrated P help the analyst?** Yes, as an ordering inside the Elevated queue:

| Kept candidates, by calibrated P (quintiles) | CDMs | Truly Elevated |
|---|---|---|
| lowest | 2,808 | 2.9% |
| 2 | 2,809 | 6.7% |
| 3 | 2,832 | 17.1% |
| 4 | 2,750 | 40.8% |
| highest | 2,789 | 74.6% |

Sorting by it puts about 4/5 of the truly-Elevated kept CDMs (3,203 of 3,956) in the top two fifths. It must not be used to demote: the
lowest fifth still holds about 80 truly-Elevated CDMs on CV.

## 4. Can a threshold or feature change beat v1 on false alarms at equal or lower invisible under-tier?

Full pipeline per outer fold, recall target varied (`scripts/review_thresholds.py`):

| Config (train CV) | False alarms | Removed | Removed (≥ 2 d) | Under-tier | Invisible (CDMs / events) | needs_review | Flagged |
|---|---|---|---|---|---|---|---|
| Pc bound rule | 28,019 | 0% | 0% | 0 | 0 / 0 | 0 | 46.0% |
| v1@0.98 | 8,241 | 70.6% | 64.4% | 72 | 51 / 24 | 6,627 | 33.8% |
| v1@0.985 | 8,989 | 67.9% | 61.3% | 60 | 42 / 18 | 6,720 | 34.3% |
| **v1@0.99 (shipped)** | **10,056** | **64.1%** | **57.0%** | **39** | **23 / 10** | 6,851 | 34.9% |
| v1@0.993 | 10,954 | 60.9% | 53.4% | 29 | 16 / 8 | 6,949 | 35.5% |
| v1@0.995 | 11,776 | 58.0% | 50.2% | 17 | 11 / 8 | 7,000 | 36.0% |
| v1@0.997 | 12,579 | 55.1% | 46.9% | 14 | 10 / 8 | 7,012 | 36.5% |
| v1@0.999 | 13,928 | 50.3% | 41.6% | 8 | 4 / 3 | 7,112 | 37.3% |
| v1 + no demotion right after a kept CDM | 11,723 | 58.2% | 50.6% | 25 | 17 / 7 | 6,851 | 36.0% |
| v1 + review flag on the first demotion in an event | 10,056 | 64.1% | 57.0% | 39 | 15 / 7 | 10,597 | 34.9% |
| v2@0.992 (`origin/detect/v2-visible`, re-run here) | 9,185 | 67.2% | – | 33 | 20 / 7 | 6,602 | 34.4% |
| **v2@0.995** | **10,163** | **63.7%** | – | **17** | **9 / 2** | 6,660 | 35.0% |
| v2@0.997 | 10,830 | 61.3% | – | 8 | 1 / 1 | 6,673 | 35.4% |

The v2 rows come from that branch's `scripts/cv_compare.py`, which uses the same outer folds but not main's 7-row
untrusted-input floor. On that basis v1@0.99 is 10,049 / 39 / 23 / 10. Critical recall is 100% in every row.

- **No v1 threshold beats v1 on both axes.** The recall targets form a frontier.
- **Event persistence does not help.** "No demotion right after a kept CDM" lands where v1@0.995 is, with more
  under-tier (25 vs 17).
- **Review flags on demotions cost more than they buy.** Flagging every first demotion makes 8 invisible CDMs
  visible, but it adds 3,746 review flags.
- **Only the v2 feature set moves the frontier.** It is the evidence that a feature change works. At equal false
  alarms (v2@0.995 against v1@0.99), v2 has 56% fewer under-tiered CDMs (17 vs 39), and its invisible misses drop from
  10 events to 2. At equal under-tier (17), v2 has 1,613 fewer false alarms than v1@0.995 (10,163 vs 11,776).
- **The rejection of v2 rested on test noise.** On test, v2@0.992 showed 3 under-tiered CDMs, all of them visible, and
  v1 showed 1. CV expects ~5.0 and ~5.9. The CV evidence says v2 is safer *and* cheaper. The README line "our safety
  gate caught 3 more under-tiered CDMs" should change whether or not v2 ships: that comparison is noise, not the gate
  working.

## 5. Event level (Kalent's framing) and the action queue

- Kalent's §2.2 finding holds, and it explains a lot: on train, 98.6% of final-Critical events are Critical on miss
  distance alone. The Pc demoter therefore mostly changes the *Elevated* workload, not the Critical decisions.
- Persistence: miss-only persistence is the strongest final-tier predictor (Critical F2 0.818) and never catches an
  escalation (0 / 244). On CV, the action queue (#39, merged) moves escalations out of MONITOR from 108 to 163 and cuts
  final-Critical events left in MONITOR from 10 to 7, at a MONITOR share of 68.4% → 62.1%. `escalation_watch`
  precision is 21% (76 / 356). It is deterministic and can only raise a queue, so it carries no gate risk.
- **Quick win:** the queue's ANALYST REVIEW rule includes `needs_review`. For kept candidates that band is 98% false
  alarms (§3), so ANALYST REVIEW mixes the most and least worrying Elevated rows. Ordering ANALYST REVIEW by the
  calibrated P from #3 fixes this without touching the queue rules.
- Event-level demotion persistence was tested in §4 and does not help.

## 6. Are the baselines fair? The baseline judges will ask about

Untuned rules on **test**, 24,484 CDMs. They are fixed rules, nothing was fitted, and scoring them on test is allowed:

| Rule | Critical recall | False alarms | Flagged | Under-tiered |
|---|---|---|---|---|
| Miss-distance rule (official 1 / 5 km) | 95.9% (91 missed) | 0 | 31.4% | 1,116 |
| Pc bound rule (status quo) | 100% | 4,534 | 54.2% | 0 |
| Pc bound OR miss < 1 km (drops the 1-5 km Elevated band) | 100% | 4,534 | 47.3% | 1,693 |
| **Miss rule + Pc bound for Critical only** | **100%** | **8** | **31.5%** | **1,012** |
| Pc bound with the Elevated line at 1e-5 (round number, untuned) | 100% | 524 | 35.0% | 674 |
| Second Look v1 (from EVAL.md) | 100% | 2,214 | 44.7% | 1 |

Tuned simple rules, **train CV only**. Thresholds are chosen on the training folds with the model's own 99% rule:

| Rule (train CV) | False alarms | Under-tier |
|---|---|---|
| Pc bound rule | 28,019 | 0 |
| Pc bound, threshold shifted (1 parameter; picks about 10^−5.94) | 25,311 | 47 |
| Pc bound, one threshold per miss-distance decile (10 parameters) | 24,941 | 62 |
| Miss ≤ 10 km Elevated + Pc bound Critical | 26,032 | 2,248 |
| Miss ≤ 50 km Elevated + Pc bound Critical | 111,593 | 47 |
| **Second Look v1** | **10,056** | **39** |

What this means:
- **"Miss rule + Pc bound for Critical only" is the strongest simple baseline.** It is the one a judge will reach for,
  because it beats us on false alarms (8 vs 2,214) and workload (31.5% vs 44.7%) with the same 100% Critical recall.
  The price is 1,012 truly-Elevated CDMs shown as below threshold, which is its own under-tier, against our 1. It must
  be in the table: it shows that our value is the Pc-Elevated band. We flag ~3,200 more CDMs than it does: ~2,200 are false alarms and ~1,000 are
  truly-Elevated CDMs it would miss.
- **A tuned threshold does not get close.** With the same 99% guarantee, a tuned Pc-bound threshold removes 9.7% of
  false alarms and v1 removes 64.1%, with fewer under-tiered CDMs (39 vs 47). This is the best single number for
  "the model adds value beyond a rule". A tuned miss threshold is far worse, because miss distance carries little Pc
  information (NASA handbook; Kalent §2.2).
- **The miss rule's macro F1 of 0.952 is structurally flattering.** The miss tier is one half of the label, so the rule
  cannot produce a false alarm by construction. Say so next to it.
- **"100% Critical recall by construction" relies on the bound holding.** Train has 564 CDMs (test 101) where true
  risk exceeds `max_risk_estimate`, by at most 0.14 decade (median 0.001). None crosses a tier line, on either split.
  Worth one sentence in Known limits.
- **Two small inconsistencies to fix:** README / ALGO say "4,526 false Elevated" and EVAL says "4,534 false alarms".
  Both are right (8 are Pc-only Criticals that are truly below threshold), but use one number per table.

## Reproduce

```
uv run python scripts/review_oof.py                         # v1 nested CV cache (~20 s)
for r in 0.98 0.985 0.993 0.995 0.997 0.999; do uv run python scripts/review_oof.py --recall $r; done
uv run python scripts/review_errors.py                      # §1, §3
uv run python scripts/review_critical_flag.py               # §2
uv run python scripts/review_thresholds.py                  # §4
uv run python scripts/review_baselines.py                   # §6 (test: untuned rules only)
```
v2 rows: `scripts/cv_compare.py` from `origin/detect/v2-visible`, `--configs v2@0.992 v2@0.995 v2@0.997`.
