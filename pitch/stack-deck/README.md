# Second Look · Conjunction Triage Stack (deck)

An animated 16:9 HyperFrames slideshow that explains how Second Look works, layer by layer. It is built
on the same pattern as the SDTH deck, and it animates real captures of our dashboard.

## Present it

1. Double-click `present.command`, or run `node tools/serve.mjs` from this folder.
2. Open http://localhost:4173/ (the command opens it for you; if 4173 is taken it uses the next free port).
3. Press **P**, or click the Present button, to open the audience tab. This tab becomes the presenter
   view, with the current slide, the next slide, editable notes and a timer.
4. Use → / Space to go forward and ← to go back. Each slide plays its build when you arrive (the camera
   moves over the dashboard, rings draw, callouts appear), so let it run while you talk.

Everything is local, so it works without venue Wi-Fi. Over Google Meet, share the audience tab
(Share screen → A tab). In Zoom, drag the audience tab into its own window and share that window.

## Edit it

- Slides: `composition/index.html`. Each scene's build lives in a `B["s-..."]` function at the bottom.
- Speaker notes: `notes/script.md`. Text before `--` is spoken; text after it is presenter-only.
  Then run `python3 tools/build.py`, which writes the notes into both copies of the JSON island
  (`composition/index.html` and `index.html`) and the slide timing.
- Dashboard captures: start the app (`uv run uvicorn server:app --port 8040` from the repo root), then
  `node tools/capture-ui.mjs`. Then convert the PNGs to webp (the commands are in the script's header).
- Check: `npm run check` (HyperFrames lint plus the runtime, layout and contrast audits).

## Slides (13)

Cover · 1 The problem · 2 The stack · 3 Layer 1 Data · 4 Layer 2 Risk pipeline · 5 Layer 3 Report files ·
6 Layers 4 + 5 Server and dashboard · 7 One click, end to end · 8 Where Claude fits · 9 How we know it
works · 10 In progress · 11 Why Second Look · Close
