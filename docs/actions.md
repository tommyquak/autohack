# Event action queue

Code: `triage/actions.py` · evaluation: `scripts/eval_actions.py` · contract: `docs/CONTRACT.md` §2 (`action`).

The nowcast (`docs/ALGO.md`) gives each event a tier. This layer turns the tier, the cautions and the trend across
updates into **one of three queues**, so an analyst knows what to do next. It is the decision part of Kalent's
Framework A (`docs/algorithm/algorithm.md` §3) without his ML forecast, and it is deterministic.

| Queue | Meaning |
|---|---|
| **MANEUVER PLANNING** | The current tier is Critical. An analyst should start planning. Whether to act is the operator's decision. |
| **ANALYST REVIEW** | A human should look now: Elevated, `needs_review`, `no_covariance`, `pc_diluted`, or a below-threshold event with `escalation_watch`. |
| **MONITOR** | Below threshold, no caution, no trend flag. Keep watching new updates. Below threshold is not the same as no risk. |

## Rules

Each event gets exactly one queue, and a later rule never lowers it.

1. Tier Critical → MANEUVER PLANNING.
2. Elevated, `needs_review`, `no_covariance` or `pc_diluted` → ANALYST REVIEW.
3. Below threshold with `escalation_watch` → ANALYST REVIEW.
4. Otherwise → MONITOR.

**`escalation_watch`** applies to events that are not yet Critical and have at least 1 day left before TCA. It is set when
the latest miss distance is **near the next threshold up** and at least one of three signals holds:

- **Near:** under 7.5 km for a below-threshold event (the 5 km line), or under 1.5 km for an Elevated event (the 1 km
  line).
- **Signals:**
  - *Just above:* within 20% above that threshold.
  - *Closing:* over the last 3 updates, the miss distance fell by at least 25% and the Pc upper bound rose.
  - *Not settled:* the last update moved the miss distance by 20% or more, in either direction.

An Elevated event with the flag stays in ANALYST REVIEW; the flag says it may become Critical. The 1-day floor is a
policy choice and was not tuned, because every input in the protocol below is at least 2 days out.

**Inputs:** only fields already in `events.json`: tier, `needs_review`, cautions, `latest.*` and the history's miss
distance and Pc upper bound. `risk`, `true_tier` and `risk_log10` are never read. A test checks that changing them
changes nothing.

**Forecast hook:** if an event carries Kalent's planned `forecast` object (`p_final`, `prediction_set`), it can only
raise the queue:

- Critical in the prediction set, or P(Critical) ≥ 0.5 → MANEUVER PLANNING.
- P(Elevated or worse) ≥ 0.2 → at least ANALYST REVIEW.

Both thresholds are placeholders until his conformal step calibrates them. Nothing depends on the hook today.

## How the evidence shaped the rules

The task proposed "miss distance shrinking with a rising Pc bound". On train, a strict closing trend alone was a weak
signal. Two things predicted escalation better:

- **Proximity to the next threshold.** A below-threshold event under 6 km escalated 18% of the time, against a 2.3% base
  rate.
- **An unsettled track.** A miss distance that jumped by 20% or more in the last update.

The rule therefore needs proximity, and then accepts any of the three signals. The thresholds were picked from a
648-point grid by event-grouped cross-validation (5 folds, train only). The objective was flagged escalations minus
0.2 × flagged non-escalations, so a flag must be right at least 1 time in 6 to be worth an analyst's time. The per-fold
picks were stable: near 7.5 km in 4 of 5 folds, swing 20% and shrink 25% in all 5.

## Results: Kalent's protocol, train only

We follow Kalent's protocol (algorithm.md §1.4):

- **Events:** at least one CDM ≥ 2 days before TCA, and a final CDM < 1 day before TCA. That gives 8,293 events: 551 end
  Critical and 244 escalate.
- **Input:** only the CDMs ≥ 2 days out, run through the same pipeline as the dashboard (`model.predict`, then
  `build_events.build`). The nowcast model itself is refit out-of-fold, so no held-out event tiered itself.
- **Truth:** the final CDM's true tier, computed from `risk` and miss distance.
- **Escalation:** the final true tier is higher than the true tier at the 2-day cutoff.

**Persistence** takes the queue from the current nowcast tier only. Our tier over-warns, so persistence already lifts
some escalations out of MONITOR. Kalent's 0/244 figure is for the true tier, which uses the label.

| Train, 8,293 events | Persistence | Rules without watch | **Action queue (CV)** |
|---|---|---|---|
| Final-Critical in MANEUVER or REVIEW (coverage) | 98.2% | 98.2% | **98.7%** |
| Final-Critical left in MONITOR (misses) | 10 | 10 | **7** |
| Final-Critical in MANEUVER PLANNING | 458 / 551 | 458 / 551 | 458 / 551 |
| Escalations out of MONITOR (of 244) | 108 | 122 | **163** |
| Below-threshold escalations out of MONITOR (of 155) | 19 | 33 | **74** |
| `escalation_watch` flags: escalated / did not | – | – | **76 / 280** (precision 21%) |
| MONITOR share (workload saved) | 68.4% | 64.8% | **62.1%** |

"Action queue (CV)" uses the thresholds picked on the other four folds for each event, so it is an honest held-out
number. With the shipped thresholds, picked on all of train, the in-sample figures are 103 / 334 flags, 180
escalations out of MONITOR and 61.3% MONITOR.

**Sensitivity to the 0.2 weight:**

| Weight | Flags: escalated / did not | Escalations out of MONITOR | Final-Critical in MONITOR | MONITOR share |
|---|---|---|---|---|
| 0.1 | 122 / 452 | 190 | 6 | 60.5% |
| 0.2 (shipped) | 76 / 280 | 163 | 7 | 62.1% |
| 0.33 | 46 / 110 | 141 | 8 | 63.9% |

**Trade-off:** about 6 more points of events go to review than under persistence. In exchange, 55 more escalations and
3 more final-Critical events reach a human before the 2-day mark.

**On test** (2,167 events, `data/demo/events.json`): 196 events go to MANEUVER PLANNING, 738 to ANALYST REVIEW (114
with the watch flag) and 1,233 to MONITOR. This metric **cannot be computed on test**, because no test CDM is within 2
days of TCA, so there is no final tier to score against.

Reproduce with `uv run python scripts/eval_actions.py`. The first run takes about 5 minutes, because it refits the
nowcast for each fold. It writes `reports/action_eval.json`.

## Limits

- **Not a forecast.** The rules are hand-shaped and tuned on 244 escalations, and they catch 76 of them out-of-fold.
  Kalent's forecast model is the intended upgrade, through the hook.
- **Missed Criticals.** 7 final-Critical events (1.3%) still sit in MONITOR at the 2-day mark. All 7 were below threshold
  at the cutoff, 8 km or more away, and either stable or seen in only one update. A daily re-run will move them as new CDMs arrive.
- **Untested last day.** The rules were not tested inside 2 days of TCA, and the 1-day floor on the watch is untested
  policy.
- **No conformal guarantee.** The numbers hold for events like the training events.
- **Wording.** MANEUVER PLANNING means "start planning". The text never recommends a manoeuvre, and tier 0 is never
  called safe.
