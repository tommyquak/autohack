# Second Look · Conjunction Triage Stack (deck)

An animated 16:9 HyperFrames slideshow for Second Look: bounded, inspectable demotion. It is built on the same
pattern as the SDTH deck and animates real captures of our product (Horizon prediction replay, Decision point,
Review page, dashboard) plus the live audit.

## Present it

1. Double-click `present.command`, or run `node tools/serve.mjs` from this folder.
2. Open http://localhost:4173/ (the command opens it for you; if 4173 is taken it uses the next free port).
3. Press **P**, or click the Present button, to open the audience tab. This tab becomes the presenter
   view, with the current slide, the next slide, editable notes and a timer.
4. Use → / Space to go forward and ← to go back. Each slide fades up and plays its build when you arrive (the
   camera moves slowly over the capture, rings draw on, callouts appear), so let it run while you talk. Going
   back replays the slide cleanly; with prefers-reduced-motion the finished slide shows at once.

Everything is local, so it works without venue Wi-Fi. Over Google Meet, share the audience tab
(Share screen → A tab). In Zoom, drag the audience tab into its own window and share that window.

## Edit it

- Slides: `composition/index.html`. Each scene's build lives in a `B["s-..."]` function at the bottom.
- Speaker notes: `notes/script.md`. Text before `--` is spoken; text after it is presenter-only.
  Then run `python3 tools/build.py`, which writes the notes into both copies of the JSON island
  (`composition/index.html` and `index.html`) and the slide timing.
- Captures: start the app (`uv run uvicorn server:app --port 8098` from the repo root; copy `reports/model.joblib`
  in first), then `node tools/capture-ui.mjs http://127.0.0.1:8098`. Horizon frames use `#demo=<id>&cdm=<n>`
  (paused at CDM n; no `cdm` = the case's end state) and `#view=globe`. Convert the PNGs to webp (commands in the
  script's header). The script also freezes `GET /api/audit` into `assets/ui/audit.json`.
- Type scale (1920x1080): headline 72 · subhead 44 · body 30 · note 24 · label 24 mono caps · callout 24 ·
  minimum 22. Content sits on a 96 px margin grid between y 340 and 952.
- Check: `npm run check` (HyperFrames lint plus the runtime, layout and contrast audits).

## Slides (13)

Cover (the Horizon screen on a monitor: night globe, event 805 Critical; screen rendered once by
`tools/cover-screen.html` to `composition/assets/cover-screen.png`, render command in its header) · 1 The problem ·
2 Why Second Look (the USP) · 3 The stack · 4 Risk pipeline · 5 The official task (decision point, final-tier
forecast vs keep today's tier, 5-fold CV) · 6 Decision record · 7 It proves it live (replay trace + /api/audit +
/api/triage) · 8 Honest evaluation · 9 Where it fails (event 1278) · 10 Safety gate (v2 didn't ship) ·
11 In progress (forecast confusion matrix, the shipped 0.90 target with 0.95 as a sensitivity, the distance-rule comparison) · Close

Forecast numbers come from docs/FORECAST.md and data/demo/forecast_metrics.json at the shipped operating point
(90% final-Critical recall target, PR #74). dash-final is the dashboard's default Final tier view (#67); eval is the Evaluation tab's official panel
(#68); the per-message captures (dash-model, dash-baseline, compare-1278) are from deck v2 (the dashboard's Now view).
