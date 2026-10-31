// Capture the real dashboard as deck assets: 1920x1080 CSS px at 2x device pixels (sharp when the deck zooms in),
// plus the on-screen rectangles of the elements the deck highlights (composition/assets/ui/rects.json).
//
// 1. Serve the app (frozen data/demo reports, no API key, so explanations and the copilot use the fallback):
//      cd <repo> && uv run uvicorn server:app --port 8040
// 2. node tools/capture-ui.mjs [base-url]        (default http://127.0.0.1:8040)
//    Needs puppeteer-core; set PUPPETEER_DIR to a node_modules folder that has it if it is not resolvable here.
// 3. Convert: for f in composition/assets/ui/*.png; do cwebp -quiet -q 86 "$f" -o "${f%.png}.webp" && rm "$f"; done
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PUPPETEER_DIR ? process.env.PUPPETEER_DIR + "/" : import.meta.url);
const puppeteer = require("puppeteer-core");
const BASE = process.argv[2] || "http://127.0.0.1:8040";
const OUT = fileURLToPath(new URL("../composition/assets/ui/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rects = {};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
});
async function rect(page, key, sel) {
  rects[key] = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), text: (el.innerText || "").slice(0, 120) };
  }, sel);
}
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` }).then(() => console.log("shot", name));
async function dash(hash = "") {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#queue .row");
  await wait(2500);
  return page;
}

// Main view: model tiers (default), then the baseline rule, then an Ask-bar question.
let p = await dash();
await shot(p, "dash-model");
const sels = {
  workload: "#workload", seg: ".stage-bar .seg", queue: "#queue", row1: "#queue .row", stamp: "#stamp",
  hero: "#detail .hero", why: "#detail .why", explain: "#d-explain", funnel: "#funnel-wrap", tabs: "#tabs",
  ask: "#ask", detail: "#detail", window: "#window-fold",
};
for (const [k, s] of Object.entries(sels)) await rect(p, k, s);
await p.click('[data-mode="baseline"]');
await wait(2500);
await shot(p, "dash-baseline");
await rect(p, "workloadBaseline", "#workload");
await p.click('[data-mode="model"]');
await wait(2000);
await p.type("#ask-input", "Which events are Critical?");
await p.click("#ask-send");
await wait(5000);
await shot(p, "dash-ask");
await rect(p, "askCard", "#ask-card");
await p.close();

p = await dash("#encounter");
await wait(4000);
await shot(p, "encounter");
await rect(p, "encView", "#panel-encounter .enc-view");
await p.close();

p = await dash();
await p.click('#tabs [data-tab="globe"]');
await wait(5000);
await shot(p, "globe");
await p.close();

p = await dash();
await p.click('#tabs [data-tab="eval"]');
await wait(3000);
await shot(p, "eval");
for (const [k, s] of Object.entries({
  evLead: ".ev-lead", evNote: ".ev-note", evTable: ".ev-table", evMissRow: ".ev-table tbody tr:nth-child(2)",
  evModelRow: ".ev-table tr.is-model", evMatrix: ".ev-matrix", evFailure: ".ev-failure",
})) await rect(p, k, s);
await p.close();

p = await dash("#compare=1278");
await wait(4000);
await shot(p, "compare-1278");
await p.close();

p = await browser.newPage();
await p.goto(`${BASE}/chat`, { waitUntil: "networkidle0" });
await p.type("#input", "Which Critical events close in under 3 days?");
await p.click("#send");
await wait(5000);
await shot(p, "chat-answer");
await rect(p, "chatLog", "#log");
await p.close();

writeFileSync(OUT + "rects.json", JSON.stringify(rects, null, 1));
await browser.close();
