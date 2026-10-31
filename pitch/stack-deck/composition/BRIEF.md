---
workflow: slideshow
flow: automation
storyboard: no
message: "Second Look clears the noise from an analyst's warning queue, and by design it can never hide a Critical"
destination: live-pitch
aspect: 1920x1080
language: en
audience: "Our own team first (how the stack fits together), then Autonomous SG 2026 judges, Airbus Challenge #1"
length: 130s of slides, about 5-6 min spoken
---

## Intent

An animated explainer deck for Second Look (conjunction triage), modelled on Tommy's SDTH deck
(Garudians-demo/hyperframes-deck): the same wrapper, vendored runtime and fonts, presenter view,
speaker notes built into the JSON island, and Night Instrument look. It explains the system layer by
layer (data, risk pipeline, report files, server, dashboard, with Claude beside the stack), then one
click end to end, where Claude fits, how we know it works, what is in progress, the three-beat USP,
and the close.

Like the SDTH deck showed demo clips, every layer ties back to what the analyst sees: the slides
animate real captures of our dashboard (assets/ui/, made by tools/capture-ui.mjs from the frozen
data/demo reports with no API key): camera push-ins, rings that draw on, callouts, and a cross-fade
between the Baseline rule and Model states. Where no capture exists yet (the action queue), a plainly
labelled placeholder frame stands in.

## Assets

- assets/ui/*.webp: dashboard (model and baseline), Ask bar answer, Encounter (3D), Globe, Evaluation,
  Compare for event 1278, the /chat copilot answering. 1920x1080 at 2x. rects.json holds the
  on-screen boxes the rings use.

## Notes

- Numbers only from README.md, docs/*.md, data/demo/metrics.json and data/demo/events.json (summary).
- Tier 0 is "below threshold", never "safe"; it is drawn neutral grey, never green.
- Critical recall 100% comes from the rules, not the model; the slides say so.
- Copilot: 38/38 avoid "safe" and 38/38 no manoeuvre advice, 35/38 grounded, fallback mode only.
- No uniqueness claims. Hook: "Every team here will predict collision risk. Second Look is built so
  it can never hide a Critical."
- No AI attribution on slides.
