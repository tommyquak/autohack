# Speaker notes for Second Look (deck v2). Text before '--' is spoken (about 20-30 s a slide); after it is presenter-only (sources, cautions, Q&A). Every UI image is a real capture of our product on the frozen data/demo reports with no API key (tools/capture-ui.mjs). Run `python3 tools/build.py` after editing. Wording rules: say "preserves every rule-defined Critical", never "never misses a collision"; the 99% is a recall target, not a guarantee; tier 0 is "below threshold", never "safe"; no "only one" claims.
@cover
This is Second Look, conjunction triage with bounded, inspectable demotion. It cuts the analyst's review queue by a quarter, shows a decision record for every downgrade, and it's architecturally forbidden from downgrading a rule-defined Critical. Behind me is our Horizon view: the orbits are simulated, but every flag, and the trace under it, is real.
--
Background: four real captures of /static/horizon.html (#t=0, #t=41, #t=44, #demo=482), cross-faded. The orbits are simulated for illustration; real: each event's crossing latitude, relative speed, miss distance and time-to-TCA order (the page says so). The trace under EVT 482 comes from its certificate in events.json and the live GET /api/audit (11 checks PASS). Quarter = 1,090 → 802 events (README).

@problem
Our user is the conjunction analyst who looks at every flagged warning. Today's rule flags a warning when its Pc upper bound or its miss distance crosses a threshold. The bound is deliberately loose, so the rule flags 54.2 percent of our test CDMs, and 4,534 of those are truly below threshold. That's 1,090 events in the queue.
--
54.2% of 24,484 test CDMs; 4,534 false alarms = truly below threshold, flagged at any tier (README "The problem", docs/EVAL.md). README also quotes "false Elevated" 4,526: the difference is 8 CDMs shown Critical by the Pc bound. 1,090 = baseline Elevated 894 + Critical 196 (events.json summary). Tier 0 is "below threshold", never "safe".

@usp
So here's what Second Look does differently. One: it cuts the queue by a quarter, 1,090 to 802 events. Two: every one of the 288 downgrades carries a certificate, so you can inspect why. Three: every rule-defined Critical stays Critical, because the model is never allowed to act on one. That's the claim: bounded, inspectable demotion.
--
Event level: all 288 removed events were truly below threshold at their latest update. Message level: 1 genuinely Elevated CDM was demoted (event 1278, scene 9). Critical recall 100% on test comes from the rules, not the model. Do NOT say "never misses a collision" or "the only". Certificate fields: rules_fired, candidate / why_not_candidate, model_score vs threshold, decision, four invariants, holds (docs/CONTRACT.md §6). 196 rule-defined Critical events = audit check critical_by_rule_stays_critical.

@stack
How it works, in five layers. Data at the bottom, then the risk pipeline, the report files, the web server, and the analyst views on top. Every tier is decided in layer two and frozen in layer three, with its certificate. Claude sits to the side and only writes explanations. It never sets a tier.
--
Layers: README "How it works"; docs/CONTRACT.md. Without an API key a template writes the explanation and the tier is identical. The copilot (/chat) still exists but is not featured in this deck. Views: dashboard (/), review page (feat/review-console, PR open), decision point (/static/decision.html), horizon (/static/horizon.html).

@pipeline
Layer two decides every tier. The NASA and ESA rules from the brief tier each message first. Then the model gets one narrow job: demote a warning that is Elevated only because of the loose Pc bound, and only when its inputs are usable and its score is under the threshold. Switch the dashboard to the model and the queue drops from 1,090 to 802. Critical is never touched.
--
Rules: triage/tiers.py (Critical Pc ≥ 1e-4 or miss < 1 km; Elevated Pc ≥ 1e-6 or 1-5 km). Model: gradient-boosted trees with monotonic constraints (triage/model.py). Threshold = 1% quantile of out-of-fold scores on truly-Elevated candidates: a 99% recall target, measured out of fold, not a guarantee. Both screenshots are real: the Baseline rule / Model toggle.

@task
On 31 October the organisers sharpened the task: predict each event's final tier, with a probability, from the messages received at least two days out, and report Critical recall and a confusion matrix on an 80/20 split by event. This is our Decision point view: real tracks on the left, the forecast on the right. Our forecaster's numbers are still pending.
--
Forecast numbers: [pending: final-tier forecaster] (PR "Final-tier forecaster"; docs/FORECAST.md is not on main yet, so we quote no numbers). Until it lands, the right side of /static/decision.html places each event by its current tier and says so on screen. Our current evaluation (later scenes) is per CDM on the organisers' test file, not the 80/20 event split. Every update in the data is ≥ 2 days out (minimum 2.0002 d).

@record
Every downgrade opens to its decision record. Here's event 1071: Elevated by the Pc bound alone, eligible, a score of 0.00074 under the threshold of 0.0083, so it was demoted, and all invariants hold. Event 482 is a rule-defined Critical, so it isn't eligible and stays Critical. The record shows why. The analyst decides what to do.
--
Review page captured from feat/review-console (open PR, not on main yet); its top bar reads "Guardrails PASS 7/7" because that branch predates the 11-check audit on main. Event 1071: demoted Elevated → below threshold, debris, miss 6,388 m, 2.00 d. Event 482: payload, miss 601 m, placeholder sigma (no_covariance), queue MANEUVER PLANNING = start planning; whether to act is the operator's decision.

@live
And it proves it live. Every decision carries a certificate, and the Horizon trace reads it: rule fired, model not allowed, audit pass. GET slash api slash audit re-checks eleven invariants over all 2,167 events and 24,484 decisions. POST slash api slash triage tiers any CDM you send, with its certificate. Tamper with the file and the audit fails and names the check.
--
GET /api/audit on main: status PASS, 11/11 checks (frozen copy in assets/ui/audit.json; README still says 7/7, written before the four newer checks). Counts: 2,167 events, 24,484 CDM decisions, 153 kept, 288 demoted, 1,726 not eligible. All 288 demotions have score < threshold (the audit checks the stored score; it does not re-derive it). POST /api/triage without a model artifact runs "rules only"; the deck example is a sample CDM (data/sample) tiered Elevated with all four invariants true. Tamper test: docs/CONTRACT.md §6.

@eval
Now the honest part. The strongest simple baseline, the miss rule plus the Pc bound for Critical only, beats us on false alarms: 8 against our 2,214. The price is 1,012 truly Elevated messages shown as below threshold; we show one. Our value is the Pc-Elevated band. And on train cross-validation, the model removes 64.1 percent of false alarms, against 9.7 for a tuned Pc threshold.
--
docs/EVAL.md and README "Results". Test table: status quo 100% / 4,534 / 0 under-tiered; miss-distance rule 95.9% (misses 91 Critical CDMs) / 0 / 1,116 (best macro F1 0.952, flattering by construction); miss rule + Pc for Critical only 100% / 8 / 1,012 (workload 31.5% vs our 44.7%); ours 100% / 2,214 / 1. The two untuned rules are fixed from the brief, so scoring them on test is a baseline, not tuning. CV (train only, nested, event-grouped 5-fold, same 99% rule): tuned Pc threshold 9.7% removed, 47 under-tiered; model 64.1%, 39 under-tiered.

@fail
Here's where it fails. One genuinely Elevated message was shown below threshold: event 1278, 4.62 days out. Its Pc bound was 10 to the minus 5.61; the truth was just over the Elevated line. The analyst would still see it: the updates before and after stayed Elevated. And on 26 junk and edge-case files, every one was rejected or flagged.
--
README "Where it fails": test row 14473, miss 23,375 m, true Pc 10^-5.92, shown below threshold with confidence 0.99 and no flag; the 5.12 d update before and the 4.39 d update after (needs review) stayed Elevated; baseline_tier is kept next to tier. Robustness 26/26 (docs/robustness.md): rejected clearly or flagged, never quietly tiered too low. Capture: dashboard Compare tab, #compare=1278.

@gate
We set our safety gate before testing and stuck to it. Model v2 cut false alarms by a further 23 percent, but it showed three truly Elevated messages as below threshold, against our limit of one. So it didn't ship. And we're honest that the gate is weak: test counts are noisy. The stricter gate is on cross-validation, and that's our next step.
--
README "Our eval caught our bug" and docs/EVAL.md "Safety gate". v1's CV rate predicts about 5.9 under-tiered CDMs on a test set this size, so seeing ≤ 1 had about a 2% chance (Poisson). Stricter gate: operator-invisible under-tier on train CV (not needs_review, no later update shown at its true tier): v1 23 CDMs in 10 events. v2@0.995: same workload (+1.1% false alarms), 17 under-tiered, 9 invisible; not shipped, never run on test. First model regressed log Pc and flagged 100% of CDMs.

@next
What's next. The final-tier forecaster for the official task is in an open pull request, and we won't quote its numbers until they're on main. The review page is also in review. And to be clear about limits: the 99 percent is a recall target, not a guarantee, and we don't yet have calibrated Pc, a live feed, orbit propagation, or test data inside two days.
--
Pending: Critical recall and confusion matrix [pending: final-tier forecaster]; use docs/FORECAST.md numbers exactly once it is on main. No test CDM is closer than 2 days (minimum 2.0002 d), so the final window is untested. Horizon orbits are simulated. Claude-mode explanations are not evaluated (copilot eval was fallback mode).

@close
So, Second Look. Rules decide every tier. The model only removes over-warnings, and every removal is on the record. Claude only writes explanations. And the analyst always decides. It preserves every rule-defined Critical. Thank you, we'd love your questions.
--
Run it: uv sync, then uv run uvicorn server:app (serves the frozen data/demo reports); GET /api/audit for the live check. Interfaces: docs/CONTRACT.md. Method: docs/ALGO.md. Evaluation: docs/EVAL.md. Background: Horizon view pulled back to the globe (simulated orbits).
