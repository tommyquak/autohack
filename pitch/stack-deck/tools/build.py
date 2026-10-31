#!/usr/bin/env python3
"""Build the slideshow island from notes/script.md and write it into composition/index.html and the
root direct-open wrapper index.html (kept in sync). Adapted from the SDTH deck's tools/build.py.

Also writes the slide timing into the composition (/*TIMING*/ ... /*END*/ and each scene's
data-start / data-duration): 10 s per scene. The composition squeezes each slide's build into the
first 4.6 s so the slideshow's rest frame (the scene midpoint) is the finished slide; while
presenting, the wrapper replays the build in real time on each slide change.

Usage: python3 tools/build.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMP = ROOT / "composition" / "index.html"
WRAP = ROOT / "index.html"
NOTES = ROOT / "notes" / "script.md"

# notes key, sceneId (data-composition-id), scene element id
SLIDES = [
    ("cover", "cover", "s-cover"),
    ("problem", "problem", "s-problem"),
    ("usp", "usp", "s-usp"),
    ("stack", "stack", "s-stack"),
    ("pipeline", "pipeline", "s-pipe"),
    ("task", "task", "s-task"),
    ("record", "record", "s-record"),
    ("live", "live", "s-live"),
    ("eval", "eval", "s-eval"),
    ("fail", "fail", "s-fail"),
    ("gate", "gate", "s-gate"),
    ("next", "next", "s-next"),
    ("close", "close", "s-close"),
]
SCENE = 10
WPM = 129  # the team's measured speaking pace (SDTH pitch)
MIN_HOLD = 3


def parse_notes():
    blocks = {}
    for part in NOTES.read_text().split("\n@")[1:]:
        key, body = part.split("\n", 1)
        spoken, _, extra = ("\n" + body).partition("\n--\n")
        blocks[key.strip()] = (spoken.strip(), extra.strip())
    return blocks


def island():
    blocks = parse_notes()
    slides, total = [], 0
    for key, scene, _el in SLIDES:
        spoken, extra = blocks[key]
        secs = max(MIN_HOLD, round(len(spoken.split()) * 60 / WPM))
        cue = f"{total // 60}:{total % 60:02d}"
        total += secs
        # spoken script first: the presenter's UP NEXT shows the next slide's first line
        note = (f"{spoken}\n\n" if spoken else "") + f"[about {secs} s, from {cue}]"
        if extra:
            note += f"\n{extra}"
        slides.append({"sceneId": scene, "notes": note})
    return {"slides": slides}, total


def replace_island(html, js):
    pat = re.compile(r'(<script type="application/hyperframes-slideshow\+json">)(.*?)(</script>)', re.S)
    if not pat.search(html):
        raise SystemExit("no island in file")
    return pat.sub(lambda m: m.group(1) + "\n" + js + "\n    " + m.group(3), html, count=1)


def timing():
    scenes = [[el, i * SCENE, SCENE, 0] for i, (_k, _s, el) in enumerate(SLIDES)]
    return {"total": len(SLIDES) * SCENE, "scenes": scenes}


def put_timing(html, tm):
    html = re.sub(r"/\*TIMING\*/.*?/\*END\*/", lambda m: "/*TIMING*/" + json.dumps(tm) + "/*END*/", html, flags=re.S)
    for (_k, scene, _el), (_e, start, dur, _c) in zip(SLIDES, tm["scenes"], strict=True):
        pat = re.compile(rf'<div\b[^>]*\bdata-composition-id="{scene}"[^>]*>')
        m = pat.search(html)
        assert m, f"no scene {scene}"
        tag = re.sub(r'data-start="[\d.]+"', f'data-start="{start}"', m.group(0))
        tag = re.sub(r'data-duration="[\d.]+"', f'data-duration="{dur}"', tag)
        html = html[: m.start()] + tag + html[m.end() :]
    return re.sub(
        r'(data-composition-id="deck"\s*data-start="0"\s*data-duration=")[\d.]+(")',
        lambda m: f"{m.group(1)}{tm['total']}{m.group(2)}",
        html,
    )


WRAPPER = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Second Look · Conjunction Triage</title>
    <script>
      if (new URLSearchParams(location.search).get("mode") === "audience") {
        document.title = "Second Look · Audience";
      }
    </script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #07090b; }
      hyperframes-slideshow { display: block; position: relative; width: 100vw; height: 100vh; }
      hyperframes-player { position: absolute; inset: 0; }
    </style>
    <script src="vendor/hyperframes-player.global.js"></script>
    <script src="vendor/hyperframes-slideshow.global.js"></script>
  </head>
  <body>
    <!-- Direct-open deck. Serve this folder over http (double-click present.command, or
         `node tools/serve.mjs`), open http://localhost:4173/, press P (or the Present button) for the
         audience tab; this tab becomes the presenter view. -->
    <hyperframes-slideshow tabindex="0" notes-storage-key="triage-stack-v2">
      <hyperframes-player
        interactive
        runtime-src="vendor/hyperframe.runtime.iife.js"
        src="composition/index.html"
      ></hyperframes-player>
      <!-- DUPLICATED ISLAND: generated from notes/script.md by tools/build.py,
           identical to the island in composition/index.html. -->
      <script type="application/hyperframes-slideshow+json">
    </script>
    </hyperframes-slideshow>
    <script>
      // Live presenting, for every player on the page (main view, presenter preview, audience tab).
      // The slideshow seeks straight to each slide's finished rest frame, so each composition is armed
      // (__stackArm) to watch its own slide changes and, in the same frame, fade the new slide up and replay
      // its build in real time (__stackEnter). The poll below arms new players and is a fallback.
      // Renders and checks never run this page.
      (function () {
        function players() {
          var out = [];
          (function walk(root) {
            root.querySelectorAll("*").forEach(function (el) {
              if (el.tagName === "HYPERFRAMES-PLAYER") out.push(el);
              if (el.shadowRoot) walk(el.shadowRoot);
            });
          })(document);
          return out;
        }
        var seen = new WeakMap();
        function tick() {
          players().forEach(function (pl) {
            var d, w;
            try {
              d = pl.iframeElement && pl.iframeElement.contentDocument;
              w = d && d.defaultView;
            } catch (e) { d = null; }
            if (!d || !w) return;
            if (w.__stackArm && !w.__stackArmed) w.__stackArm();
            var current = null;
            d.querySelectorAll(".scene").forEach(function (sc) {
              var cs = w.getComputedStyle(sc);
              if (cs.visibility !== "hidden" && cs.display !== "none") current = sc.getAttribute("data-composition-id");
            });
            if (current && seen.get(pl) !== current) {
              seen.set(pl, current);
              if (w.__stackEnter) w.__stackEnter(current);
            }
          });
        }
        setInterval(tick, 100);
      })();
    </script>
  </body>
</html>
"""


def main():
    data, total = island()
    js = json.dumps(data, indent=2, ensure_ascii=False).replace("</", "<\\/")
    COMP.write_text(put_timing(replace_island(COMP.read_text(), js), timing()))
    WRAP.write_text(replace_island(WRAPPER, js))
    # The player bundles in vendor/ are pinned copies taken from the SDTH deck; not refreshed here.
    print(f"island: {len(data['slides'])} slides, spoken script about {total} s at {WPM} wpm")


if __name__ == "__main__":
    main()
