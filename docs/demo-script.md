# Demo script: Second Look (3 minutes, live)

Autonomous SG 2026 · Airbus Challenge #1. Modelled on lvl 500's HackHarvard 2026 `docs/demo-script.md`.
Every number below is shown on screen or sits in a repo file; the source is in brackets. Don't read out any number that isn't on this page.
Say **"below threshold"**, never "safe". Say **"Pc upper bound"**, never "collision probability".

## Beats

Flow: the queue shrinks → one removed alert and its decision record → a Critical the model may not touch → the live
audit → the failure case → close. No chatbot and no globe in the demo. Items marked **[pending #49]** need PR #49
("Assured triage": per-decision certificates and `/api/audit`); until it lands, use the fallback line given.

| Time | Who | Screen action | Point at |
|---|---|---|---|
| 0:00-0:40 | Tommy, then Reagan | Dashboard on **Triage funnel**: click **Baseline rule**, then **Model** | Workload bar: Flagged 1,090 → 802, Critical kept 196 |
| 0:40-1:15 | Reagan | Click a faded (removed) dot → detail for **EVT 1071** | "Rule said Elevated; the model demoted it", reason line, confidence; certificate **[pending #49]** |
| 1:15-1:45 | Franky | Queue row 1 (**EVT 482**) → detail | Reason line "miss distance 601 m < 1 km"; certificate "not eligible: Critical" **[pending #49]** |
| 1:45-2:15 | Tommy | Second tab: `/api/audit` **[pending #49]** | `PASS` and the named checks |
| 2:15-2:50 | Kalent | Third tab: `/#compare=1278`, hover the Pc point at 4.6 d | Hover "1e-5.6 · Below threshold", above the dashed 1e-6 line |
| 2:50-3:00 | Tommy | Back to funnel | Nothing; eyes on judges |

## 0:00-0:40 · The queue shrinks (Tommy, then Reagan)

> Every team here will predict collision risk. Second Look cuts the review queue by a quarter, shows a decision record
> for every downgrade, and is architecturally forbidden from downgrading a rule-defined Critical.
> Our user is a conjunction analyst. Today's rule flags a CDM when its Pc upper bound or its miss distance crosses a
> threshold. On our 24,484 test CDMs it flags 54.2%, and 4,534 of those are truly below threshold.

Reagan:
> Each dot is an event. Here's the rule: **[click Baseline rule]** 1,090 events to review. Now the model: **[click
> Model]** the dots that fade are over-warnings it removed. 802 events, 288 fewer. All 288 were truly below threshold at
> their latest update. Critical kept: 196.

Numbers: 24,484 and 54.2% [`data/demo/metrics.json` `n`, `max_risk_estimate_rule.flagged_rate`]; 4,534 [same,
`confusion[0][1]` + `confusion[0][2]` = 4,526 + 8]; 1,090, 802 and 196 [`data/demo/events.json` summary `by_baseline_tier`
and `by_tier`]; 288 removed, all with `true_tier` 0 [`events.json`, events with `baseline_tier > tier`].

## 0:40-1:15 · One removed alert and its decision record (Reagan)

> Event 1071. The rule said Elevated: its Pc upper bound, 10^-5.68, sits in the Elevated band, but the objects are
> 6.4 km apart. That is the only kind of warning the model may touch: Elevated by Pc alone, more than 5 km apart, usable
> covariance. Its score fell below the cut, so it is shown below threshold, and the rule's tier stays next to it.

**[pending #49]** Point at the certificate: the rule that fired, the eligibility checks (not Critical, not Elevated by
miss distance, usable covariance, no missing input) and the model score against the stored threshold.
Fallback until #49 lands: point at "Rule said Elevated; the model demoted it" and the reason line; don't claim the score
or the checks are on screen.

Numbers: EVT 1071, 2.0 d, miss 6,388 m, bound 10^-5.68, confidence 0.99 [`events.json` event 1071].

## 1:15-1:45 · A Critical the model is forbidden to downgrade (Franky)

> Event 482, top of the queue. Its Pc upper bound is only in the Elevated band, but the miss distance is 601 m, under
> 1 km, so the rules make it Critical. The model never sees it: Critical is not eligible. 135 of our 196 Critical events
> are Critical on miss distance alone.

**[pending #49]** Point at the certificate line "not eligible: Critical". Fallback: point at the reason line and at the
rule tier equal to the shown tier.

Numbers: EVT 482, 601 m, 10^-4.38 [`events.json` first event]; 135 of 196 [summary `critical_drivers.miss_only`].

## 1:45-2:15 · The live audit (Tommy)

> **[pending #49]** `/api/audit` recomputes the rules from every event's inputs and checks every decision: no Critical
> shown lower, no demotion outside the eligible slice, no demotion with a score above the threshold. It says PASS.

Fallback until #49 lands: "Every output keeps the rule's tier next to the model's, so any demotion shows as a demotion,
and the tests check that the model never lowers a Critical." Source: `docs/ALGO.md` §2 "What can never happen".

## 2:15-2:50 · The failure case (Kalent)

> Two measurements. By event, every removed event was truly below threshold. By message, one genuinely Elevated CDM
> was demoted: event 1278, at 4.6 days, shown below threshold with no flag. The updates before and after stayed
> Elevated, so the analyst still saw the event. And the strongest simple rule, miss distance plus the Pc bound for
> Critical only, flags fewer CDMs than we do, but it hides 1,012 truly Elevated ones; we hide 1.

Numbers: event 1278, row 14473, 4.62 d, miss 23,375 m, bound 10^-5.61, true 10^-5.92 [`README.md` "Where it fails";
`events.json` event 1278 history]; 1,012 and 31.5% [`docs/EVAL.md`].

## 2:50-3:00 · Close (Tommy)

> A quarter of the queue gone, every rule-defined Critical kept, and a record of why for every downgrade. The analyst
> decides. Thank you.

## Pre-demo checklist

- [ ] `uv sync`, then `uv run uvicorn server:app --port 8000` and open `http://127.0.0.1:8000`.
- [ ] No `reports/` folder (or a fresh one). The server reads `reports/` before `data/demo/`, so stale local runs change the numbers.
- [ ] Header says `split: test`; stamp says `2,167 events`. If not, stop and fix before going on stage.
- [ ] Tab 1: dashboard on **Triage funnel**, **Baseline rule** pressed, clock at `NOW · snapshot`. Tab 2: `http://127.0.0.1:8000/api/audit` (only if PR #49 has landed). Tab 3: `http://127.0.0.1:8000/#compare=1278`.
- [ ] Browser zoom 110-125% so the workload bar reads from the back; full screen; notifications off.
- [ ] API errors (red banner, "Could not load events"): restart uvicorn, reload. Backup: screenshots of each beat in a local folder.
- [ ] Run the whole script with a stopwatch twice. If over 3:00, cut the strongest-baseline line in Kalent's beat first.

## Claims we can make

- Every rule-defined Critical is preserved: Critical recall 100% on the 24,484-CDM held-out test set [`metrics.json`].
- Event level: all 288 removed events were truly below threshold at their latest update. Message level: 1 genuinely
  Elevated CDM was demoted (event 1278) [`events.json`, `metrics.json`].
- False Elevated CDMs down 51% vs the status quo rule (4,526 → 2,206); flagged share 54.2% → 44.7% [`metrics.json`].
- Events in the queue 1,090 → 802 [`events.json`].
- The model can only demote Elevated → below threshold on one narrow slice; it never touches Critical [`docs/ALGO.md`].
- On train CV, under the same 99% rule, a tuned Pc-bound threshold removes 9.7% of false alarms; the model removes 64.1% [`docs/EVAL.md`].
- 26/26 robustness cases pass, 0 crashes, on a 1,764-row sample [`docs/robustness.md`].

## Do not claim

- **Time saved.** We measured counts, not analyst minutes (`README.md`).
- **That 99% is a guarantee.** It is a recall target, measured on out-of-fold scores (not a formal guarantee), for
  events drawn like the training events, and not per event.
- **That "needs review" marks the riskiest events.** On an Elevated event it marks a close call just above the demotion
  bar, which is mostly an over-warning [`docs/ALGO.md` §2].
- **That our safety gate proved v2 worse.** The test under-tier counts (1 vs 3) are noise; see `docs/EVAL.md`.
- **Any forecast result.** Kalent's escalation forecast (`docs/algorithm/algorithm.md`, `feature.md`) is planned; no code or numbers are on `main`.
- **"Safe".** Tier 0 is "below threshold". Also don't claim a calibrated Pc, live feed, or orbit propagation.

## Likely judge questions

- **Why not just use the miss-distance rule? It has the best F1.** It misses 91 of 2,227 Critical CDMs (95.9% recall). We won't trade Criticals for F1. Its F1 is flattering by construction: miss distance is half of the label, so it can never raise a false alarm [`metrics.json`, `docs/EVAL.md`].
- **Miss rule + Pc bound for Critical flags fewer CDMs than you. Why not that?** It does: 8 false alarms, 31.5% flagged, 100% Critical recall. But it shows 1,012 truly Elevated CDMs as below threshold; we show 1 [`docs/EVAL.md`].
- **Is the model better than a tuned threshold?** On train CV with the same 99% rule: tuned threshold 9.7% of false alarms removed, model 64.1% [`docs/EVAL.md`].
- **Why didn't v2 ship?** It failed the gate we fixed before testing it (3 under-tiered test CDMs vs our limit of 1). That count is noisy; on CV a stricter v2 setting halves under-tiering at the same workload. It is our next step, never run on test [`docs/EVAL.md`].
- **Why is the 24 h window empty?** No test CDM is under 2 days to TCA (min 2.0002 d), so `events_in_window` is 0. The final window is untested [`README.md`, `events.json`].
- **Where does it fail, and how would the analyst know?** Cautions (`no_covariance` 63 events, `pc_diluted` 25), needs review (84 events), and `baseline_tier` next to `tier`, so any demotion is visible. Event 1278 is the case none of these caught [`events.json`, `README.md`].
- **Why use Claude at all?** To turn fields into a readable handover note. It only rewords fixed facts, never sets a tier, and each response records `claude` or `template` [`triage/explain.py`].
- **What about Pc?** We use the provided Pc upper bound plus a classifier, not a calibrated Pc. That's an honest gap [`README.md` "What we don't solve yet"].
- **Why do so many Criticals sit above 60° latitude?** 72% of events and 125 of 196 Criticals are there, where polar orbits cross. Display only, not a model input [`events.json` `by_latitude_band`, section 05].
- **What's next?** A per-event forecast of the final tier from CDMs 2+ days out, to fill the 24 h view. Planned, not shipped.
