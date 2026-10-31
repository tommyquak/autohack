// Globe tab: the demo view. Every event is a tier-coloured dot at its REAL conjunction-point latitude, in front of an
// illustrative sky. One small header (tier counts, review workload), one "next 24 h" counter, and one compact card for
// the selected event. Everything else (queue, detail rail, copilot) stays one click away but out of the picture.
//
// What is data:   each event's LATITUDE (CDM geocentric_latitude) and the ALTITUDE of its target's orbit (the mean of
//                 target_altitude_km, perigee to apogee). Every event is a dot coloured by its tier and drawn at that
//                 height above the globe, to scale with the globe.
//                 The CDM files have no longitude, so a dot's east-west position is arbitrary: a fixed spread from the
//                 event id (golden angle), so dots are stable between loads. The key says so.
//                 Click a dot (or the Critical count) to open its card.
// What is not:    the stars and the continents' lighting. No orbits or background traffic are drawn: the data has none.
//
// d3 and topojson load the first time the tab opens; offline, the globe still draws without land outlines.
import { CAUTIONS, MAX_DAYS, TIERS, clamp, esc, fmtDays, fmtDist, fmtPc } from "./fmt.js";
import { baseOf, passesFilters, remaining, set, state, subscribe, tierOf } from "./state.js";

const D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const TOPO = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js";
const LAND = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json";
const OWN = "#5ea9ff";
// Threshold positions for drawing the Pc scale and the 1 km counts only. Which rule fired comes from event.reasons.
const RISK_CRIT = -4, RISK_ELEV = -6, MISS_CRIT_M = 1000, MISS_ELEV_M = 5000;
let canvas, ctx, wrap, card, head, d3, land = null;
let reviewPage = false; // "Open in review" shows only once /static/review.html is known to exist
let w = 0, h = 0, dpr = 1;
let rot = 20, tilt = 24; // spin and tilt toward the viewer, degrees
let aim = null; // {rot, tilt} the globe eases toward so the selected dot faces the viewer
const auto = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let dots = [];
let hoverDot = null;
let cardOpen = false;
let drag = null;
let raf = 0, last = 0, clock = 0, ready = false;
let stars = [];

const panel = () => document.getElementById("panel-globe");
const isOpen = () => panel() && !panel().hidden;
const lat = (e) => e.latest.geocentric_latitude_deg;
const n = (v) => v.toLocaleString("en");
const selected = () => state.events.find((e) => e.event_id === state.selectedId);

function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function initGlobe() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/globe.css" });
  document.head.append(css);

  // Header readouts for the globe view; the replay clock takes this space on the other tabs.
  document.querySelector(".top .spacey").insertAdjacentHTML(
    "afterend",
    `<div class="top-tiers num" id="top-tiers" aria-label="Events by tier"></div>
     <div class="top-review num" id="top-review"></div>`,
  );

  document.getElementById("tabs").insertAdjacentHTML("afterbegin", `<button role="tab" aria-selected="false" data-tab="globe">Globe</button>`);
  document.getElementById("panel-eval").insertAdjacentHTML(
    "afterend",
    `<div class="panel" id="panel-globe" role="tabpanel" hidden>
      <div class="canvas-wrap" id="globe-wrap">
        <canvas id="globe" tabindex="0" aria-label="Globe of events by real latitude. Arrow up and down step through events, most urgent first; Escape closes the card."></canvas>
        <p class="globe-head" id="globe-head"></p>
        <div class="globe-key" id="globe-key"></div>
        <p class="globe-hint" id="globe-hint" hidden></p>
        <section class="globe-24" id="globe-24" aria-label="Next 24 hours"></section>
        <div class="globe-tip" id="globe-tip" hidden></div>
        <section class="globe-card" id="globe-card" hidden aria-live="polite"></section>
      </div>
    </div>`,
  );
  wrap = document.getElementById("globe-wrap");
  canvas = document.getElementById("globe");
  ctx = canvas.getContext("2d");
  card = document.getElementById("globe-card");
  head = document.getElementById("globe-head");

  // Tab switching itself is the generic data-tab handler in encounter.js; here we only start and stop drawing.
  // The side panels collapse on every tab (rails.js); on the globe they start collapsed.
  const setView = (v) => (document.body.dataset.view = v);
  setView(document.querySelector('#tabs [aria-selected="true"]')?.dataset.tab || "");
  document.getElementById("tabs").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tab]");
    if (btn) setView(btn.dataset.tab);
    if (ev.target.closest('[data-tab="globe"]')) {
      set({ elapsed: 0, playing: false }); // the globe shows the snapshot: the replay clock starts again from now
      queueMicrotask(open);
    }
    else stop();
  });
  fetch("/static/review.html", { method: "HEAD" })
    .then((r) => ((reviewPage = r.ok), cardOpen && paintCard()))
    .catch(() => {});
  new ResizeObserver(resize).observe(wrap);

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
  });
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", () => ((hoverDot = null), (drag = null), (canvas.style.cursor = ""), paintTip(null), redraw()));
  canvas.addEventListener("keydown", onKey);
  card.addEventListener("click", (ev) => ev.target.closest('[data-act="close"]') && closeCard());
  document.getElementById("top-tiers").addEventListener("click", (ev) => {
    if (!ev.target.closest('[data-act="critical"]')) return;
    const c = state.events.find((e) => tierOf(e) === 2 && remaining(e) > 0); // API order: soonest first within a tier
    if (c) set({ selectedId: c.event_id });
  });

  const rebuild = () => {
    dots = buildDots();
    buildSky();
    paintTop();
    paintHead();
    paintKey();
    paint24();
    if (isOpen()) redraw();
  };
  subscribe(["events", "summary"], rebuild);
  subscribe(["selectedId"], () => ((cardOpen = state.selectedId != null), aimAt(selected()), paintCard(), kick()));
  subscribe(["filters"], () => redraw());
  subscribe(["horizon"], () => (paintTop(), cardOpen && paintCard(), redraw()));
  subscribe(["elapsed"], () => (paint24(), cardOpen && paintCard(), redraw()));
  rebuild();
}

// One dot per event: real latitude, arbitrary but fixed longitude (golden-angle spread by event id).
function buildDots() {
  const fallback = 1 + 700 / 6371;
  return state.events.filter((e) => lat(e) != null).map((e) => {
    const a = e.latest.target_altitude_km;
    const r = a && a[0] != null ? 1 + (a[0] + a[1]) / 2 / 6371 : fallback; // orbit altitude as a multiple of the Earth's radius
    return { e, lat: lat(e), lon: ((e.event_id * 137.50776405) % 360) - 180, r };
  });
}

// Stars only. Seeded, so the sky is the same on every load.
function buildSky() {
  const rnd = prng(7);
  stars = Array.from({ length: 360 }, () => ({ x: rnd(), y: rnd(), r: 0.3 + rnd() ** 3 * 1.3, a: 0.18 + rnd() * 0.5, p: rnd() * 6.28, s: 0.5 + rnd() * 1.6, warm: rnd() < 0.2 }));

}

// Header: tier counts in the tier shown, and the review workload of its base vs. it. Now: the conservative rule vs.
// the model (summary counts). Final tier: the rule floor vs. the forecast (counted from the events' forecast).
function paintTop() {
  const s = state.summary;
  if (!s) return;
  const final = state.horizon === "final";
  const count = (f) => {
    const c = Object.fromEntries(TIERS.map((x) => [x.name, 0]));
    for (const e of state.events) c[TIERS[f(e)].name]++;
    return c;
  };
  const t = final ? count(tierOf) : s.by_tier, b = final ? count(baseOf) : s.by_baseline_tier;
  if (final) {
    const review = (x) => x.Elevated + x.Critical;
    const esc_ = state.events.filter((e) => tierOf(e) > baseOf(e)).length;
    paintTiers(t);
    const el = document.getElementById("top-review");
    el.innerHTML = `<span class="muted">${n(review(b))}</span> → <b>${n(review(t))}</b> forecast to need review <span class="muted">(rule floor → forecast, ${n(esc_)} escalated)</span>`;
    el.title = `Elevated + Critical at closest approach. Rule floor at the latest message 2+ days out: ${n(review(b))}. Forecast final tier: ${n(review(t))}. The forecast never lowers the floor.`;
    return;
  }
  paintTiers(t);
  const review = (x) => (x.Elevated ?? 0) + (x.Critical ?? 0);
  const el = document.getElementById("top-review");
  if (b) {
    const fewer = review(b) ? Math.round((1 - review(t) / review(b)) * 100) : 0;
    el.innerHTML = `<span class="muted">${n(review(b))}</span> → <b>${n(review(t))}</b> to review <span class="muted">(rule → Second Look, ${fewer}% fewer)</span>`;
    el.title = `Elevated + Critical. Conservative rule: ${n(review(b))}. Second Look: ${n(review(t))}. Second Look never downgrades a rule-defined Critical.`;
  } else {
    el.innerHTML = `<b>${n(review(t))}</b> to review`;
  }
}

function paintTiers(t) {
  const tier = (i, key) => `<span class="tt"><i style="background:${TIERS[i].color}"></i><b>${n(t[key] ?? 0)}</b> ${esc(TIERS[i].name)}</span>`;
  document.getElementById("top-tiers").innerHTML =
    `<button type="button" class="tt-btn" data-act="critical" title="Open the most urgent Critical">${tier(2, "Critical")}</button>${tier(1, "Elevated")}${tier(0, "Below threshold")}`;
}

// One sentence, computed from the data: the point of the picture.
function paintHead() {
  const withLat = state.events.filter((e) => lat(e) != null);
  if (!withLat.length) return void (head.textContent = "No latitude in this data file.");
  const polar = withLat.filter((e) => Math.abs(lat(e)) >= 60).length;
  head.textContent = `${Math.round((polar / withLat.length) * 100)}% of encounters happen above 60° latitude, where near-polar orbits cross.`;
}

function paintKey() {
  document.getElementById("globe-key").innerHTML = `
    ${[2, 1, 0].map((t) => `<div class="gk-row"><i style="background:${TIERS[t].color}"></i>${esc(TIERS[t].name)}</div>`).join("")}
    <div class="gk-note">One dot per event, at its real latitude and orbit height. The data has no longitude, so east–west is arbitrary.</div>`;
}

// Next 24 h: how many events reach closest approach within the Critical miss distance (1 km). The test set has no CDM
// under 2 days to TCA, so this is usually 0; it says why, and shows the same count for every later 24 h window.
function paint24() {
  const box = document.getElementById("globe-24");
  const up = state.events.filter((e) => remaining(e) > 0);
  const inDay = (e, d) => remaining(e) > d && remaining(e) <= d + 1;
  const close = (e) => e.latest.miss_distance_m < MISS_CRIT_M;
  const now = up.filter((e) => inDay(e, 0));
  const danger = now.filter(close).length;
  const nearest = up.length ? Math.min(...up.map(remaining)) : null;
  const note = !up.length
    ? "No event left before closest approach."
    : !now.length
      ? `No event reaches closest approach in the next 24 h. The nearest is ${nearest.toFixed(1)} d out.`
      : `${n(now.length)} event${now.length === 1 ? "" : "s"} reach closest approach in the next 24 h.`;
  const days = Array.from({ length: MAX_DAYS }, (_, d) => up.filter((e) => inDay(e, d) && close(e)).length);
  box.innerHTML = `
    <h2 class="g24-k">Next 24 h</h2>
    <p class="g24-v"><b class="num">${n(danger)}</b> within 1 km</p>
    <p class="g24-note">${esc(note)}</p>
    <p class="g24-cap">Within 1 km, per 24 h window</p>
    <ol class="g24-days">${days
      .map((c, d) => `<li class="${c ? "on" : ""}" aria-label="${d} to ${d + 1} days: ${c} within 1 km"><span>${d}–${d + 1} d</span><b class="num">${n(c)}</b></li>`)
      .join("")}</ol>`;
}

// Which rule fired, straight from the pipeline's event.reasons, with Pc written as 4.2e-5. Basis: is the rule tier
// backed by the Pc bound (one of its reasons is the Pc reason for that tier) or by the miss distance alone?
const pcText = (r) =>
  r.replace(/Pc 10\^(-?\d+(?:\.\d+)?)/, (_, v) => `Pc bound ${fmtPc(Number(v))}`).replace(/ in \[1e-6, 1e-4\) \(elevated band\)/, " in the elevated band");
function ruleOf(e) {
  const rs = e.reasons || [];
  const text = rs.map(pcText).join(" and ") || "—";
  if (!(e.baseline_tier > 0)) return { text, basis: null };
  const pcKey = e.baseline_tier === 2 ? "critical threshold" : "elevated band";
  return { text, basis: rs.some((r) => r.startsWith("Pc") && r.includes(pcKey)) ? "Pc-backed" : "Distance only" };
}

// Pc upper bound on a log scale from 1e-9 to 1e-2, with the two thresholds marked.
function pcScale(pc, grey = false) {
  const W = 132, lo = -9, hi = -2, x = (v) => ((clamp(v, lo, hi) - lo) / (hi - lo)) * W;
  const band = (a, b, c) => `<rect x="${x(a)}" y="7" width="${x(b) - x(a)}" height="4" fill="${c}" opacity=".35"/>`;
  const tick = (v, t) => `<line x1="${x(v)}" x2="${x(v)}" y1="4" y2="14" stroke="#7d8a85"/><text x="${x(v)}" y="24" text-anchor="middle">${t}</text>`;
  const mark = pc != null && Number.isFinite(pc) ? `<path d="M${x(pc) - 4} 0 L${x(pc) + 4} 0 L${x(pc)} 7 Z" fill="${grey ? "#7d8a85" : "#e6ebe8"}"/>` : "";
  return `<svg class="gc-scale" viewBox="0 0 ${W} 26" aria-hidden="true">${band(lo, RISK_ELEV, TIERS[0].color)}${band(RISK_ELEV, RISK_CRIT, TIERS[1].color)}${band(RISK_CRIT, hi, TIERS[2].color)}${tick(RISK_ELEV, "1e-6")}${tick(RISK_CRIT, "1e-4")}${mark}</svg>`;
}

function paintCard() {
  const e = selected();
  if (!cardOpen || !e) return void (card.hidden = true);
  const L = e.latest, shown = tierOf(e), t = TIERS[shown], r = remaining(e), rule = ruleOf(e);
  const fc = state.horizon === "final" && e.forecast ? e.forecast : null;
  const pc = L.max_risk_estimate_log10, m = L.miss_distance_m;
  const pcOk = pc != null && Number.isFinite(pc);
  const missCmp = m == null ? "" : m < MISS_CRIT_M ? "under 1 km" : m <= MISS_ELEV_M ? "1–5 km" : "over 5 km";
  const cautions = e.cautions?.length ? e.cautions : e.needs_review ? ["needs_review"] : [];
  const demoted = e.baseline_tier > e.tier;
  const noCov = cautions.includes("no_covariance"); // placeholder sigma: Pc is greyed, not to be relied on alone
  card.style.setProperty("--tier", t.color);
  card.innerHTML = `
    <button type="button" class="gc-close" data-act="close" aria-label="Close the event card">×</button>
    <h3 style="color:${t.color}"><span aria-hidden="true">${t.icon}</span> ${shown === 2 ? "Critical (Maneuver Required)" : esc(t.name)}</h3>
    <p class="gc-sub num">EVT ${esc(e.event_id)} · ${esc(String(L.object_type).toLowerCase())}${fc ? " · forecast final tier" : ""}</p>
    ${fc && fc.predicted_final_tier > fc.floor_tier ? `<p class="gc-line">Forecast escalates it from <b style="color:${TIERS[fc.floor_tier].color}">${esc(TIERS[fc.floor_tier].name)}</b> (rule floor) at closest approach: ${esc(fc.reasons?.[0] || "")}</p>` : ""}
    ${fc && shown !== e.tier ? `<p class="gc-line">Latest message now: <b style="color:${TIERS[e.tier].color}">${esc(TIERS[e.tier].name)}</b>.</p>` : ""}
    <dl class="gc-rows">
      <div><dt>Miss distance</dt><dd class="num">${m == null ? "—" : fmtDist(m)} <span class="muted">${missCmp}</span></dd></div>
      <div${noCov ? ` class="grey" title="No usable covariance: do not rely on Pc alone"` : ""}><dt>Pc upper bound</dt><dd class="num">${pcOk ? `≤ ${fmtPc(pc)}` : "missing"}${noCov ? ` <span class="muted">no covariance</span>` : ""}</dd>${pcScale(pcOk ? pc : null, noCov)}</div>
      <div><dt>Time to TCA</dt><dd class="num">${r > 0 ? fmtDays(r) : "passed"}</dd></div>
      <div><dt>Rule fired</dt><dd>${esc(rule.text)}</dd></div>
      ${rule.basis ? `<div><dt>Basis</dt><dd><span class="gc-basis ${rule.basis === "Pc-backed" ? "pc" : "dist"}">${rule.basis}</span></dd></div>` : ""}
    </dl>
    ${cautions.length ? `<p class="gc-cautions">${cautions.map((c) => `<span class="caution">${esc(CAUTIONS[c] || c)}</span>`).join("")}</p>` : ""}
    ${e.tier === 2 ? `<p class="gc-line">Rule-defined Critical: Second Look cannot downgrade it. The analyst decides what to do.</p>` : ""}
    ${demoted ? `<p class="gc-line">The rule said <b style="color:${TIERS[e.baseline_tier].color}">${esc(TIERS[e.baseline_tier].name)}</b>; Second Look downgraded it. The decision record is in review.</p>` : ""}
    ${reviewPage ? `<a class="gc-open" href="/static/review.html#event=${encodeURIComponent(e.event_id)}">Open in review <span aria-hidden="true">→</span></a>` : ""}`;
  card.hidden = false;
}

function closeCard() {
  cardOpen = false;
  paintCard();
  kick();
}

// Ease the selected dot round to face the viewer (its longitude to the centre, its latitude part-way).
function aimAt(e) {
  const d = e && dots.find((x) => x.e === e);
  if (!d) return void (aim = null);
  aim = { rot: -d.lon, tilt: clamp(d.lat * 0.7, -55, 55) };
  if (!auto) ((rot = aim.rot), (tilt = aim.tilt), (aim = null));
}

function onKey(ev) {
  if (ev.key === "Escape") return closeCard();
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    if (state.selectedId != null) set({ selectedId: state.selectedId });
    return;
  }
  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
  ev.preventDefault();
  const list = state.events.filter((e) => lat(e) != null && remaining(e) > 0 && passesFilters(e)); // urgency order
  if (!list.length) return;
  const i = list.findIndex((e) => e.event_id === state.selectedId);
  const next = i < 0 ? 0 : clamp(i + (ev.key === "ArrowDown" ? 1 : -1), 0, list.length - 1);
  set({ selectedId: list[next].event_id });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, onload: resolve });
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

async function open() {
  if (!ready) {
    ready = true;
    try {
      await loadScript(D3);
      d3 = window.d3;
      try {
        await loadScript(TOPO);
        const topo = await (await fetch(LAND)).json();
        land = window.topojson.feature(topo, topo.objects.land);
      } catch {
        land = null; // no outlines offline; the dots still draw
      }
    } catch (err) {
      ready = false;
      head.textContent = `Globe library failed to load (${err.message}).`;
      return;
    }
  }
  resize();
  if (aim && !raf) ((rot = aim.rot), (tilt = aim.tilt), (aim = null)); // land already facing the selected event
  kick();
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

function kick() {
  if (!isOpen() || !d3) return;
  draw();
  if ((auto || aim) && !raf) {
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
}

// Shortest signed angle from a to b, degrees.
const turn = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

function loop(now) {
  raf = 0;
  if (!isOpen()) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (aim && !drag) {
    const k = 1 - Math.exp(-dt * 4); // exponential ease-out
    const dr = turn(rot, aim.rot), dtl = aim.tilt - tilt;
    rot += dr * k;
    tilt += dtl * k;
    if (Math.abs(dr) < 0.1 && Math.abs(dtl) < 0.1) aim = null;
  } else if (auto && !cardOpen && !drag) {
    rot = (rot + dt * 6) % 360; // the globe holds still while a card is open; the sky keeps drifting
  }
  if (auto) clock += dt;
  draw();
  if (auto || aim) raf = requestAnimationFrame(loop);
}

const redraw = () => isOpen() && d3 && !raf && draw();

function resize() {
  if (!wrap || !wrap.clientWidth) return;
  dpr = window.devicePixelRatio || 1;
  w = wrap.clientWidth;
  h = wrap.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (d3 && isOpen()) draw();
}

// Leave room around the sphere for the dots above it and the header line.
const projection = () => {
  const pad = Math.max(28, Math.min(w, h) * 0.1);
  return d3.geoOrthographic().fitExtent([[pad, pad + 24], [w - pad, h - pad]], { type: "Sphere" }).rotate([rot, -tilt]).clipAngle(90);
};

function drawStars() {
  for (const warm of [false, true]) {
    ctx.fillStyle = warm ? "#ffe2b8" : "#cfe2ff";
    for (const s of stars) {
      if (s.warm !== warm) continue;
      ctx.globalAlpha = s.a * (0.78 + 0.22 * Math.sin(clock * s.s + s.p));
      const r = s.r * 1.6;
      ctx.fillRect(s.x * w, s.y * h, r, r);
    }
  }
  ctx.globalAlpha = 1;
}

function draw() {
  if (!d3 || !w) return;
  ctx.clearRect(0, 0, w, h);
  drawStars();

  const proj = projection(), path = d3.geoPath(proj, ctx);
  const [cx, cy] = proj.translate(), R = proj.scale();

  // atmosphere: a soft blue rim just outside the limb
  const atm = ctx.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.12);
  atm.addColorStop(0, "rgba(96,176,255,.3)"); atm.addColorStop(0.35, "rgba(70,140,230,.1)"); atm.addColorStop(1, "rgba(60,120,220,0)");
  ctx.fillStyle = atm;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, 6.2832); ctx.fill();

  // ocean, lit from the upper left; darker than before so the dots carry the contrast
  ctx.beginPath(); path({ type: "Sphere" });
  const sea = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.08, cx, cy, R * 1.02);
  sea.addColorStop(0, "#1d4a73"); sea.addColorStop(0.55, "#0e2c4a"); sea.addColorStop(1, "#061424");
  ctx.fillStyle = sea; ctx.fill();

  ctx.save();
  ctx.beginPath(); path({ type: "Sphere" }); ctx.clip();

  if (land) {
    ctx.beginPath(); path(land);
    ctx.fillStyle = "rgba(60,96,110,.55)"; ctx.fill();
    ctx.strokeStyle = "rgba(170,205,220,.35)"; ctx.lineWidth = 0.7; ctx.stroke();
  }

  // night-side shading for depth
  const shade = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, R * 0.3, cx, cy, R * 1.05);
  shade.addColorStop(0, "rgba(0,0,0,0)"); shade.addColorStop(1, "rgba(2,6,14,.62)");
  ctx.fillStyle = shade; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  ctx.restore();

  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(140,200,255,.25)"; ctx.lineWidth = 1; ctx.stroke();

  drawDots(proj, cx, cy);
}

// Events as dots, tier-coloured; Critical drawn last so it stays on top. Filters dim the dots they exclude.
// A dot sits at its target's orbit height above the surface point at its latitude. An orthographic view is linear in the
// radius, so lifting a point to r x the Earth's radius just scales its offset from the globe's centre by r.
const DOT = [2.2, 2.7, 3.3]; // radius by tier: close enough that 1,365 grey dots are not drowned out by 196 red ones
function lifted(proj, cx, cy, d) {
  const p = proj([d.lon, d.lat]);
  return p ? { surface: p, up: [cx + (p[0] - cx) * d.r, cy + (p[1] - cy) * d.r] } : null; // null = far side of the globe
}

function drawDots(proj, cx, cy) {
  for (let tier = 0; tier <= 2; tier++) {
    ctx.fillStyle = TIERS[tier].color;
    ctx.strokeStyle = "rgba(4,10,18,.85)";
    ctx.lineWidth = 0.8;
    for (const d of dots) {
      if (tierOf(d.e) !== tier || remaining(d.e) <= 0) continue;
      const q = lifted(proj, cx, cy, d);
      if (!q) continue;
      ctx.globalAlpha = passesFilters(d.e) ? 0.92 : 0.1;
      ctx.beginPath();
      ctx.arc(q.up[0], q.up[1], DOT[tier], 0, 6.2832);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // the selected or hovered dot gets a ring and a thin line down to the surface point it floats above
  for (const [d, color] of [[cardOpen && dots.find((x) => x.e.event_id === state.selectedId), OWN], [hoverDot, "#e6ebe8"]]) {
    if (!d || remaining(d.e) <= 0) continue;
    const q = lifted(proj, cx, cy, d);
    if (!q) continue;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(q.surface[0], q.surface[1]);
    ctx.lineTo(q.up[0], q.up[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(q.surface[0], q.surface[1], 1.8, 0, 6.2832);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(q.up[0], q.up[1], 8, 0, 6.2832);
    ctx.stroke();
  }
}

// Nearest visible dot within 9 px of the pointer, or null.
function dotAt(ev) {
  const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const proj = projection(), [cx, cy] = proj.translate();
  let best = null, bd = 81;
  for (const d of dots) {
    if (remaining(d.e) <= 0 || !passesFilters(d.e)) continue;
    const q = lifted(proj, cx, cy, d);
    if (!q) continue;
    const dist = (q.up[0] - x) ** 2 + (q.up[1] - y) ** 2;
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}

function paintTip(d, ev) {
  const tip = document.getElementById("globe-tip");
  if (!d) { tip.hidden = true; return; }
  const r = canvas.getBoundingClientRect(), t = TIERS[tierOf(d.e)];
  const fc = state.horizon === "final" ? " (forecast)" : "";
  tip.innerHTML = `<b style="color:${t.color}">${t.icon} ${esc(t.name)}${fc}</b> · EVT ${esc(d.e.event_id)}<br>${fmtDist(d.e.latest.miss_distance_m)} · ${Math.abs(d.lat).toFixed(1)}° ${d.lat < 0 ? "S" : "N"}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(4, ev.clientY - r.top - 12 - tip.offsetHeight)}px`;
}

function onMove(ev) {
  if (!d3) return;
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = ev.clientX; drag.y = ev.clientY;
    if (drag.moved >= 4) aim = null;
    rot = (rot + dx * 0.4) % 360;
    tilt = Math.max(-80, Math.min(80, tilt + dy * 0.3));
    redraw();
    return;
  }
  const d = dotAt(ev);
  if (d !== hoverDot) { hoverDot = d; paintTip(d, ev); redraw(); }
  else if (d) paintTip(d, ev);
  canvas.style.cursor = d ? "pointer" : "";
}

function onUp(ev) {
  const wasClick = drag && drag.moved < 4;
  drag = null;
  if (!wasClick) return;
  const d = dotAt(ev);
  if (d) set({ selectedId: d.e.event_id }); // opens the card; the dot gets a ring
}
