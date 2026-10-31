---
workflow: slideshow
flow: automation
storyboard: no
message: "Second Look cuts the review queue by a quarter, shows a decision record for every downgrade, and is architecturally forbidden from downgrading a rule-defined Critical"
destination: live-pitch
aspect: 1920x1080
language: en
audience: "Our own team first (how the stack fits together), then Autonomous SG 2026 judges, Airbus Challenge #1"
length: 130s of slides, about 6 min spoken
---

## Intent

Deck v3 (31 Oct): the final Horizon prediction replay and the official forecast numbers. The replay opens the
deck as a flipbook of real captures (event 482 paused at CDM 1, 3 and 6, then event 805's end state) under a slow
push-in, with the caption "Each dot is one CDM's predicted miss point at closest approach. Orbits: real size, shape
and tilt; orientation not in the data. Manoeuvre illustrative." Then the problem, the USP (bounded, inspectable
demotion), the stack, the risk pipeline, the official task on the Decision point chart (final-tier forecast vs
keep today's tier, 5-fold CV headline, 80/20 mentioned), the decision record on the Review page (the human
decides), the live proof (replay trace, GET /api/audit 11/11 PASS, POST /api/triage), honest evaluation against
stronger baselines and train CV, the failure case (event 1278), the safety gate (v2 didn't ship), the forecast's
confusion matrix and open choices, and the close.

Motion: text never moves. Text builds are opacity-only fades (~350 ms) with gentle staggers; no count-ups.
Only captures move (slow eased push-ins, cross-faded flipbook frames), plus rings drawing on and bars filling
once. Each slide fades up from the background over 500 ms. Nothing keeps moving after a build except a slow
push-in on a capture. No back, elastic or bounce eases.

## Assets

- assets/ui/*.webp: Horizon replay frames (hz-482-c1/c3/c6, hz-805, hz-globe), Decision point, Review page (482, 1071), dashboard (model, baseline,
  evaluation), Compare for event 1278. 1920x1080 at 2x. rects.json holds the on-screen boxes the rings use;
  audit.json is a frozen copy of GET /api/audit.

## Notes

- Numbers only from README.md, docs/*.md, data/demo/*.json and GET /api/audit on main.
- Say "preserves every rule-defined Critical", never "never misses a collision". The 99% is a recall target, not
  a guarantee. No "only one" claims. Tier 0 is "below threshold", never "safe" (drawn grey, never green).
- Forecast numbers only from docs/FORECAST.md / data/demo/forecast_metrics.json at the shipped operating point.
  Say the accuracy is lower than persistence; the 90% is a recall target, not a guarantee.
- Claude only writes explanations; the copilot is not featured.
- No AI attribution on slides.
