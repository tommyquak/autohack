# Evaluation table (test set)

Produced by `uv run python -m triage.evaluate` on `main` @ `48c28d4`, test file sha256 starts `fc4110e979e7d569` (matches docs/algorithm/VERIFICATION.md).
24,484 CDMs. True classes: 15,756 below threshold, 6,501 Elevated, 2,227 Critical. Per CDM; split by event; `risk` is the label only.

| Method | Critical recall | False alarms (truly below threshold, flagged) | Flagged for review | Under-tiered CDMs | Macro F1 |
|---|---|---|---|---|---|
| Always below threshold | 0.0% | 0 | 0.0% | 8,728 | 0.261 |
| Miss-distance rule | 95.9% | 0 | 31.4% | 1,116 | 0.952 |
| Pc upper-bound rule (status quo) | 100.0% | 4,534 | 54.2% | 0 | 0.841 |
| Pc bound OR miss < 1 km (drops the 1-5 km Elevated band) | 100.0% | 4,534 | 47.3% | 1,693 | 0.779 |
| Miss-distance rule + Pc bound for Critical only | 100.0% | 8 | 31.5% | 1,012 | 0.944 |
| **Second Look (rules + model)** | 100.0% | 2,214 | 44.7% | 1 | 0.910 |

The two middle rows are fixed rules written from the brief, untuned (nothing fitted), so scoring them on test is a
baseline, not tuning (`scripts/review_baselines.py` on `review/baseline`).

**False alarms vs "false Elevated".** This table counts every truly-below-threshold CDM that is flagged, at any tier
(4,534 / 2,214). README and ALGO also quote "false Elevated" (4,526 / 2,206): the difference is the same 8 CDMs whose Pc
bound is ≥ 1e-4, so they are shown Critical and never demoted, but whose true tier is below threshold.

**Where we lose:**
- The miss-distance rule has the highest macro F1, but it under-tiers 91 truly Critical CDMs. We never accept that
  trade. Its macro F1 is also flattering by construction: miss distance is half of the label, so a miss-only rule can
  never raise a false alarm. The same holds for the miss rule + Pc-Critical baseline, whose 8 false alarms all come from
  the Pc bound.
- **The strongest simple baseline, "miss rule + Pc bound for Critical only", beats us on false alarms (8 vs 2,214) and
  workload (31.5% vs 44.7%)** at the same 100% Critical recall. The price: 1,012 truly-Elevated CDMs are shown as below
  threshold, against our 1. Our value is the Pc-Elevated band, which that rule ignores.
- "Pc bound OR miss < 1 km" is worse than the status quo on under-tier (1,693) and keeps all 4,534 false alarms.

**Critical recall 100% comes from the rules**, which set Critical; the model may only demote Pc-only Elevated warnings.
It relies on `max_risk_estimate` being an upper bound: true risk exceeds it in 101 test CDMs (564 train), by at most
0.04 decade on test (0.14 on train), and none of them crosses a tier line.

**Two measurements of what the model removed.** Event level: the review queue drops from 1,090 to 802 events, and all
288 removed events were truly below threshold at their latest update (`data/demo/events.json`). Message level: 1
genuinely Elevated CDM was demoted (event 1278, the under-tiered CDM above). The 99% is a recall target, measured on
out-of-fold scores (not a formal guarantee).

## Does the model add value beyond a tuned rule? (train CV only)

Tuned rules must not be scored on test, so this comparison is train-only, nested, event-grouped 5-fold CV. Each rule's
threshold is chosen on the training folds with the model's own 99% rule (keep ≥ 99% of truly-Elevated candidates).

| Method (train CV, 162,634 CDMs) | False alarms | Removed vs Pc-bound rule | Under-tiered CDMs |
|---|---|---|---|
| Pc upper-bound rule | 28,019 | 0% | 0 |
| Pc bound with a tuned threshold (1 parameter, ~10^-5.94) | 25,311 | 9.7% | 47 |
| Pc bound, one tuned threshold per miss-distance decile (10 parameters) | 24,941 | 11.0% | 62 |
| **Second Look v1** (full pipeline refitted per fold) | **10,056** | **64.1%** | **39** |

Under the same 99% rule, the best one-parameter rule removes 9.7% of false alarms and the model removes 64.1%, with
fewer under-tiered CDMs. That is our evidence that the model adds value beyond a threshold.

## Safety gate (how we chose between models)

- **What we did.** v2 (more history and physics features, an ensemble scorer) cut false alarms by a further 23% on
  test but showed 3 truly-Elevated CDMs as below threshold. Our gate was "no more under-tiered test CDMs than v1's 1",
  fixed before v2 was tested, so v2 did not ship.
- **Why that gate is weak.** It was set on test, where under-tier counts are noisy. v1's CV rate (39 of 162,634 train
  CDMs) predicts about 5.9 under-tiered CDMs on a test set this size (24,484), so seeing ≤ 1 had about a 2% chance
  (Poisson). Comparing 1 against 3 is comparing noise.
- **The stricter, honest gate** is *operator-invisible* under-tier on train CV: an under-tiered CDM that is not
  `needs_review` and has no later update of its event shown at or above its true tier. v1: 23 CDMs in 10 events.
- **v2 on that gate (CV only).** v2@0.992 (the setting we tested): 9,185 false alarms (−8.6%), 33 under-tiered, 20
  invisible in 7 events, so on CV it was not worse than v1. v2@0.995: the same workload (10,163, +1.1% false alarms),
  17 under-tiered, 9 invisible in 2 events. That halves under-tiering at the same workload. It is our next step: not
  shipped, and never run on test.
- These v2 rows come from `scripts/cv_compare.py` on `detect/v2-visible` (`--configs v1@0.99 v2@0.992 v2@0.995`), which
  uses the same outer folds but not main's untrusted-input floor; on that basis v1 is 10,049 false alarms / 39 / 23.

## By days to closest approach (Second Look)

| Days to TCA | CDMs | Critical recall | Flagged: status quo → Second Look |
|---|---|---|---|
| 2-4 d | 10,964 | 100.0% | 52.2% → 40.5% |
| 4-7 d | 13,520 | 100.0% | 55.7% → 48.1% |

No test CDM is closer than 2 days to TCA, so the 0-2 day buckets are empty.

## Provenance
- Reproduced independently: the model-v2 workflow's verifier re-ran v1 on the test set and got the identical confusion matrix `[[13542, 2206, 8], [1, 6335, 165], [0, 0, 2227]]`.
- **Kalent (evaluation owner) to sign off** by re-running the command above.

## Official task: final tier from >=2-day messages

The organisers' task (`challenge1_event_labels.xlsx`): predict each event's final tier from its messages with
`time_to_tca >= 2` only. Cohort: `usable_for_training == yes`, 11,942 train events (8,946 / 2,162 / 834). The xlsx
labels agree with our recomputed final tier on 13,154 of 13,154 events. Method, decision layer and limits:
[FORECAST.md](FORECAST.md). Numbers from `data/demo/forecast_metrics.json` (`uv run python -m triage.forecast`),
except the m* rule row (forecaster verifier's script, same folds).

| Method (5-fold event CV, mean ± sd; 80/20 split in brackets) | Accuracy | Critical recall | Critical precision | Critical F2 | Escalations caught | False escalations |
|---|---|---|---|---|---|---|
| Always below threshold | 0.749 (0.749) | 0 (0) | 0 (0) | 0 (0) | 0/270 (0/50) | 0 (0) |
| Persistence: miss-only tier (keep today's tier) | **0.938 ± 0.004** (0.943) | 0.865 ± 0.042 (0.886) | **0.857 ± 0.029** (0.902) | 0.863 ± 0.037 (0.889) | 0/270 (0/50) | 0 (0) |
| Persistence: `max_risk_estimate` + miss | 0.770 ± 0.012 (0.775) | 0.873 ± 0.041 (0.892) | 0.808 ± 0.036 (0.837) | 0.859 ± 0.036 (0.881) | 40/270 (10/50) | 2,135 (430) |
| Rule: Critical if latest miss < m* (tuned train-only to 90% recall, CV only) | 0.892 ± 0.011 | 0.897 ± 0.044 | 0.755 ± 0.036 | 0.864 ± 0.032 | 47/270 | 687 |
| *Reference: `risk` + miss (label column)* | *0.946 ± 0.005 (0.951)* | *0.866 ± 0.044 (0.886)* | *0.852 ± 0.029 (0.892)* | *0.863 ± 0.038 (0.887)* | *0/270 (0/50)* | *0 (0)* |
| **Second Look forecast (bounded, 90% Critical recall target)** | 0.888 ± 0.012 (0.897) | **0.911 ± 0.050 (0.910)** | 0.757 ± 0.036 (0.788) | **0.875 ± 0.037** (0.883) | **79/270 (13/50)** | 775 (142) |

Confusion matrix (Second Look, CV pooled; rows true final tier below threshold / Elevated / Critical, columns
predicted): `[[8019, 900, 27], [119, 1824, 219], [10, 64, 760]]`. Miss-only persistence:
`[[8748, 179, 19], [327, 1733, 102], [14, 99, 721]]`.

Recall-target sensitivity (CV): 0.85 → Critical recall 0.873, precision 0.808, F2 0.859, 47/270 caught, 703 false;
**0.90 (shipped)** → 0.911, 0.757, 0.875, 79/270, 775; 0.95 → 0.950, 0.565, 0.835, 115/270, 1,139. The team chose
0.90 after seeing these numbers (the original target was 0.95).

**Where we win and lose:** the forecast wins on Critical recall, Critical F2 and escalations caught; miss-only
persistence wins on accuracy, macro F1 (0.887 vs 0.834) and Critical precision, and raises no false escalations. 616 of
the 775 false escalations come from the floor (keeping Pc-only Elevated events at Elevated) before the model escalates
anything. A single miss-distance rule (m* about 1.1 km) does about as well for Critical escalation (F2 0.864 vs
0.875); the model's added value is mainly the extra escalations caught (79 vs 47) at the cost of more false escalations
(775 vs 687). On the 8,293-event Kelvins cohort (final message < 1 day, a better guide to test): Critical recall 0.883
vs 0.820, F2 0.837 vs 0.817, accuracy 0.876 vs 0.935, 72/244 escalations caught vs 0.
