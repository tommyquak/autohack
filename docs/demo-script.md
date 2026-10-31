# Demo script (3 minutes, live)

Autonomous SG 2026 · Airbus Challenge #1. Modelled on lvl 500's HackHarvard 2026 `docs/demo-script.md`.
Every number below is shown on screen or sits in a repo file; the source is in brackets. Don't read out any number that isn't on this page.
Say **"below threshold"**, never "safe". Say **"Pc upper bound"**, never "collision probability".

## Beats

| Time | Who | Screen action | Point at |
|---|---|---|---|
| 0:00-0:30 | Tommy | Dashboard open on **Triage funnel**, **Model** pressed | Header stamp "2,167 events · test-set predictions" |
| 0:30-1:00 | Reagan | Click **Baseline rule**, then **Model** | Workload bar: Flagged 1,090 → 802, Critical kept 196, recall 100% |
| 1:00-1:30 | Franky | Queue row 1 (**EVT 482**) → detail → **Encounter (3D)** tab → explanation | Miss gauge 601 m, caution, reason line |
| 1:30-2:15 | Tommy | **Triage funnel** tab, hover a faded dot | Tooltip "rule: Elevated → model: Below threshold" |
| 2:15-2:50 | Kalent | Second browser tab: `/#compare=1278`, hover the Pc point at 4.6 d | Hover "1e-5.6 · Below threshold", above the dashed 1e-6 line |
| 2:50-3:00 | Tommy | Back to funnel | Nothing; eyes on judges |

## 0:00-0:30 · Problem and user (Tommy)

> Meet a conjunction analyst on a flight dynamics team. Every CDM is a warning that something will pass close to their
> satellite. Today's rule flags a CDM when its Pc upper bound or its miss distance crosses a threshold. On our 24,484 test
> CDMs, that rule flags 54.2%, and 4,526 of those are truly below threshold. That's the false-alarm load. We cut it without
> dropping a single Critical.

Numbers: 24,484 and 54.2% [`data/demo/metrics.json` `n`, `max_risk_estimate_rule.flagged_rate`]; 4,526 [same, `confusion[0][1]`].

## 0:30-1:00 · Funnel and the rule → model toggle (Reagan)

> Each dot is an event: days to closest approach left to right, miss distance up the side. Here's the baseline rule:
> **[click Baseline rule]** 1,090 events flagged for review. Now the model: **[click Model]** the dots that fade are
> over-warnings it removed. 802 flagged, 288 fewer. Critical kept: 196. Critical recall stays 100% on 24,484 test CDMs.
> Rings mark events that need review.

Numbers: 1,090 and 802 [`data/demo/events.json` summary `by_baseline_tier` and `by_tier`, Elevated + Critical];
196 [`by_tier.Critical`]; 100% [`metrics.json` `model.critical_recall`]. On CDMs: false Elevated 4,526 → 2,206, -51% [`metrics.json` confusion; `README.md`].

## 1:00-1:30 · Top Critical event (Franky)

> Top of the queue: event 482, Critical. Its Pc upper bound is only in the Elevated band. The reason line says why: miss
> distance 601 m, under 1 km. 135 of our 196 Critical events are like this. The caution says no usable position
> uncertainty, so don't trust its Pc alone. **[Encounter (3D)]** Inside the 1 km shell. **[detail, Rewrite with Claude]**
> Claude rewords these same fields. It never sets the tier, and any text with "safe" is thrown out.

Numbers: EVT 482, 601 m, 10^-4.38, `no_covariance` [`events.json` first event]; 135 of 196 [summary `critical_drivers.miss_only`].

## 1:30-2:15 · Model and safety design (Tommy)

> Rules decide. The NASA and ESA thresholds from the brief tier every CDM. The model gets one narrow job. It looks only at
> CDMs that are Elevated purely because of a loose Pc bound, more than 5 km apart, with usable covariance. It can move them
> to below threshold, nothing else. It never touches Critical and never overrides the miss-distance rule. Its cut is the
> 1% quantile of out-of-fold scores on truly Elevated CDMs: a 99% recall target. Near the cut it raises needs review.
> And the rule's tier stays next to the model's on every row, so a demotion always shows as a demotion.

Point at: tooltip on a faded dot, or "Rule said: Elevated → model demoted" in the detail panel. Source: `docs/ALGO.md` §2.

## 2:15-2:50 · Honest evaluation (Kalent)

> Three baselines. Where we lose: the miss-distance rule has the best macro F1, 0.952 to our 0.910, but it misses 91
> Critical CDMs. Our failure: event 1278. At 4.6 days, one truly Elevated CDM shown below threshold, no flag. The updates
> before and after stayed Elevated, so the analyst still saw it. Our eval caught our first model flagging 100% of CDMs,
> so we rebuilt it. Robustness on junk input: 20 of 26, fixed to 26 of 26.

Numbers: 0.952, 0.910, 91 (= 8 + 83 in `miss_distance_rule.confusion[2]`) [`metrics.json`]; event 1278, row 14473, 4.62 d, miss 23,375 m,
bound 10^-5.61, true 10^-5.92 [`README.md` "Where it fails"; `events.json` event 1278 history]; 100% first model [`README.md`, `docs/ALGO.md` §4];
20/26 → 26/26 [`docs/robustness.md`].

## 2:50-3:00 · Close (Tommy)

> Half the false Elevated alerts gone, every Critical kept, and every tier shows the rule that fired. The analyst decides. Thank you.

## Pre-demo checklist

- [ ] `uv sync`, then `uv run uvicorn server:app --port 8000` and open `http://127.0.0.1:8000`.
- [ ] No `reports/` folder (or a fresh one). The server reads `reports/` before `data/demo/`, so stale local runs change the numbers.
- [ ] Header says `split: test`; stamp says `2,167 events`. If not, stop and fix before going on stage.
- [ ] Tab 1: dashboard on **Triage funnel**, **Model** pressed, clock at `NOW · snapshot`, EVT 482 selected. Tab 2: `http://127.0.0.1:8000/#compare=1278`.
- [ ] Browser zoom 110-125% so the workload bar reads from the back; full screen; notifications off.
- [ ] Open **Encounter (3D)** once before the demo: it loads Plotly from cdnjs, so check the venue Wi-Fi.
- [ ] No key, or the key fails: the detail panel already shows the template ("Template summary of the fields above"). Skip
      the Claude click and say "this is the template fallback; the tier never depends on Claude."
- [ ] API errors (red banner, "Could not load events"): restart uvicorn, reload. If 3D fails, it says "View unavailable"; skip
      to the explanation. Backup: screenshots of each beat in a local folder.
- [ ] Run the whole script with a stopwatch twice. If over 3:00, cut Franky's 3D line first.

## Claims we can make

- Critical recall 100% on the 24,484-CDM held-out test set; 1 CDM tiered too low [`metrics.json`].
- False Elevated CDMs down 51% vs the status quo rule (4,526 → 2,206); flagged share 54.2% → 44.7% [`metrics.json`].
- Events in the queue 1,090 → 802 [`events.json`].
- The model can only demote Elevated → below threshold on one narrow slice; it never touches Critical [`docs/ALGO.md`].
- 26/26 robustness cases pass, 0 crashes, on a 1,764-row sample [`docs/robustness.md`].

## Do not claim

- **Time saved.** We measured counts, not analyst minutes (`README.md`).
- **That 99% is a per-event guarantee.** It is a target for events drawn like the training events.
- **Any forecast result.** Kalent's escalation forecast (`docs/algorithm/algorithm.md`, `feature.md`) is planned; no code or numbers are on `main`.
- **"Safe".** Tier 0 is "below threshold". Also don't claim a calibrated Pc, live feed, or orbit propagation.

## Likely judge questions

- **Why not just use the miss-distance rule? It has the best F1.** It misses 91 of 2,227 Critical CDMs (95.9% recall). We won't trade Criticals for F1 [`metrics.json`].
- **Why is the 24 h window empty?** No test CDM is under 2 days to TCA (min 2.0002 d), so `events_in_window` is 0. The final window is untested [`README.md`, `events.json`].
- **Where does it fail, and how would the analyst know?** Cautions (`no_covariance` 63 events, `pc_diluted` 25), needs review (84 events), and `baseline_tier` next to `tier`, so any demotion is visible. Event 1278 is the case none of these caught [`events.json`, `README.md`].
- **Why use Claude at all?** To turn fields into a readable handover note. It only rewords fixed facts, never sets a tier, and each response records `claude` or `template` [`triage/explain.py`].
- **What about Pc?** We use the provided Pc upper bound plus a classifier, not a calibrated Pc. That's an honest gap [`README.md` "What we don't solve yet"].
- **Why do so many Criticals sit above 60° latitude?** 72% of events and 125 of 196 Criticals are there, where polar orbits cross. Display only, not a model input [`events.json` `by_latitude_band`, section 05].
- **What's next?** A per-event forecast of the final tier from CDMs 2+ days out, to fill the 24 h view. Planned, not shipped.
