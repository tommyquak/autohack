// Capture the real product as deck assets: 1920x1080 CSS px at 2x device pixels (sharp when the deck zooms in),
// plus the on-screen rectangles of the elements the deck highlights (composition/assets/ui/rects.json) and a frozen
// copy of the live audit (composition/assets/ui/audit.json).
//
// 1. Serve the app (frozen data/demo reports, no API key; copy reports/model.joblib in for the model tiers):
//      cd <repo> && uv run uvicorn server:app --port 8098
// 2. node tools/capture-ui.mjs [base-url] [review-base-url]   (defaults http://127.0.0.1:8098, same base for review)
//    Needs puppeteer-core; set PUPPETEER_DIR to a node_modules folder that has it if it is not resolvable here.
// 3. Convert: for f in composition/assets/ui/*.png; do cwebp -quiet -q 86 "$f" -o "${f%.png}.webp" && rm "$f"; done
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PUPPETEER_DIR ? process.env.PUPPETEER_DIR + "/" : import.meta.url);
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8098";
const REVIEW = process.argv[3] || BASE;
const OUT = fileURLToPath(new URL("../composition/assets/ui/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rects = {};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
});
async function rect(page, key, sel) {
  rects[key] = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), text: (el.innerText || "").slice(0, 160) };
  }, sel);
}
async function rects_(page, entries) { for (const [k, s] of Object.entries(entries)) await rect(page, k, s); }
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` }).then(() => console.log("shot", name));
async function open(url, sel, ms = 2500) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", url, e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  if (sel) await page.waitForSelector(sel, { timeout: 30000 });
  await wait(ms);
  return page;
}

// Dashboard: model tiers (default), then the baseline rule.
let p = await open(`${BASE}/`, "#queue .row");
await shot(p, "dash-model");
await rects_(p, { workload: "#workload", seg: ".stage-bar .seg", queue: "#queue", row1: "#queue .row", detail: "#detail", hero: "#detail .hero", why: "#detail .why" });
await p.evaluate(() => document.querySelector('[data-mode="baseline"]').click());
await wait(2500);
await shot(p, "dash-baseline");
await rect(p, "workloadBaseline", "#workload");
await p.close();

// Evaluation tab (honest eval) and the event-1278 failure case.
p = await open(`${BASE}/`, "#queue .row");
await p.evaluate(() => document.querySelector('#tabs [data-tab="eval"]').click());
await wait(3000);
await shot(p, "eval");
await rects_(p, { evLead: ".ev-lead", evTable: ".ev-table", evMatrix: ".ev-matrix", evFailure: ".ev-failure" });
await p.evaluate(() => {
  const rows = [...document.querySelectorAll(".ev-table tbody tr")];
  window.__rowRects = rows.map((r) => { const b = r.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), text: r.innerText.slice(0, 120) }; });
});
rects.evRows = await p.evaluate(() => window.__rowRects);
await p.close();

p = await open(`${BASE}/#compare=1278`, "#queue .row", 4000);
await shot(p, "compare-1278");
await p.close();

// Horizon: the prediction replay, paused at chosen CDMs (#demo=<event>&cdm=<n>; no cdm = the case's end state with
// decision, backend trace and the illustrative manoeuvre). Played as a cross-faded flipbook in the deck.
// Event 482: CDM 1 and 3 (Elevated), CDM 6 (crosses 1 km -> Critical). Event 805: end state.
const HZ = [["hz-482-c1", "#demo=482&cdm=1"], ["hz-482-c3", "#demo=482&cdm=3"], ["hz-482-c6", "#demo=482&cdm=6"], ["hz-805", "#demo=805"], ["hz-globe", "#view=globe"]];
for (const [name, hash] of HZ) {
  p = await open(`${BASE}/static/horizon.html${hash}`, "#scene", 7000);
  await shot(p, name);
  await rects_(p, {
    [name + "-panel"]: ".case-panel", [name + "-title"]: "#b-title", [name + "-cdm"]: "#b-cdm", [name + "-class"]: "#b-class",
    [name + "-trace"]: "#b-trace", [name + "-cap"]: "#replay-cap", [name + "-honesty"]: ".honesty", [name + "-man"]: "#manoeuvre:not([hidden])",
    [name + "-readout"]: "#readout", [name + "-counts"]: "#counts",
  });
  rects[name + "-parts"] = await p.evaluate(() => [...document.querySelectorAll("#b-class > *, #b-trace > *, #b-trace li")].map((el) => {
    const b = el.getBoundingClientRect();
    return { tag: el.tagName + "." + el.className, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), text: (el.innerText || "").slice(0, 90) };
  }));
  await p.close();
}

// Decision point: real tracks >= 2 d, forecast final tier on the right.
p = await open(`${BASE}/static/decision.html`, "#chart", 3000);
await shot(p, "decision");
await rects_(p, { dpChip: "#hd-chip", dpLeft: "#hd-left", dpRight: "#hd-right", dpCounts: "#counts", dpChart: "#wrap" });
await p.close();
p = await open(`${BASE}/static/decision.html#event=482`, "#chart", 3000);
await shot(p, "decision-482");
await rects_(p, { dpCard: "#card:not([hidden])", dpChip482: "#hd-chip" });
await p.close();

// Review page: queues + decision record (the human decides).
for (const ev of [482, 1071]) {
  p = await open(`${REVIEW}/static/review.html#event=${ev}`, "#list", 3500);
  await shot(p, `review-${ev}`);
  await rects_(p, { [`rv${ev}List`]: "#list", [`rv${ev}Detail`]: "#detail", [`rv${ev}Status`]: "#status" });
  rects[`rv${ev}Parts`] = await p.evaluate(() => [...document.querySelectorAll("#detail > *, #detail section, #detail h2, #detail h3")].map((el) => {
    const b = el.getBoundingClientRect();
    return { tag: el.tagName + "." + el.className, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), text: (el.innerText || "").slice(0, 90) };
  }));
  await p.close();
}

// The live audit, frozen for the deck (the slide quotes it; GET /api/audit recomputes it live).
const audit = await (await fetch(`${BASE}/api/audit`)).json();
writeFileSync(OUT + "audit.json", JSON.stringify({ status: audit.status, counts: audit.counts, checks: audit.checks.map((c) => ({ name: c.name, passed: c.passed, count: c.count })) }, null, 1));

writeFileSync(OUT + "rects.json", JSON.stringify(rects, null, 1));
await browser.close();
