// Globe tab: where encounters happen, by REAL conjunction-point latitude.
//
// Data honesty: the CDM files carry `geocentric_latitude` per event and NO longitude (train/test CSV and the .xlsx all have
// the same 103 columns), so nothing is pinned to a map point. The default view is deliberately quiet: one density shade per
// 10-degree latitude band and one headline. The numbers (tiers, critical share) open when a band is clicked.
//
// d3 and topojson load the first time the tab opens; offline, the globe still draws without land outlines.
import { LAT_BAND, TIERS, esc, latBand } from "./fmt.js";
import { state, subscribe, touchFilters } from "./state.js";

const D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const TOPO = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js";
const LAND = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json";
const N = 180 / LAT_BAND;
const SHADE = "230,235,232", OWN = "#5ea9ff";

let canvas, ctx, wrap, card, head, hint, pauseBtn, d3, land = null;
let w = 0, h = 0, dpr = 1;
let rot = 20, tilt = 24; // longitude spin and tilt toward the viewer
let auto = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let bands = [];
let hover = -1, picked = -1;
let drag = null;
let raf = 0, last = 0, ready = false;

const panel = () => document.getElementById("panel-globe");
const isOpen = () => panel() && !panel().hidden;
const lat = (e) => e.latest.geocentric_latitude_deg;
const edge = (v) => `${Math.abs(v)}°${v < 0 ? " S" : v > 0 ? " N" : ""}`;
const bandName = (i) => `${edge(i * LAT_BAND - 90)} to ${edge(i * LAT_BAND - 90 + LAT_BAND)}`;

export function initGlobe() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/globe.css" });
  document.head.append(css);

  document.getElementById("tabs").firstElementChild.insertAdjacentHTML("afterend", `<button role="tab" aria-selected="false" data-tab="globe">Globe</button>`);
  document.getElementById("panel-funnel").insertAdjacentHTML(
    "afterend",
    `<div class="panel" id="panel-globe" role="tabpanel" hidden>
      <div class="canvas-wrap" id="globe-wrap">
        <canvas id="globe" tabindex="0" aria-label="Globe of encounters by latitude band. Arrow up and down move between bands, Enter opens one."></canvas>
        <p class="globe-head" id="globe-head"></p>
        <button type="button" class="globe-pause" id="globe-pause"></button>
        <p class="globe-hint" id="globe-hint">Brighter means more encounters. Click a band for detail. Latitude only: the data has no longitude.</p>
        <section class="globe-card" id="globe-card" hidden aria-live="polite"></section>
      </div>
    </div>`,
  );
  wrap = document.getElementById("globe-wrap");
  canvas = document.getElementById("globe");
  ctx = canvas.getContext("2d");
  card = document.getElementById("globe-card");
  head = document.getElementById("globe-head");
  hint = document.getElementById("globe-hint");
  pauseBtn = document.getElementById("globe-pause");

  // Tab switching itself is the generic data-tab handler in encounter.js; here we only start and stop drawing.
  document.getElementById("tabs").addEventListener("click", (ev) => {
    if (ev.target.closest('[data-tab="globe"]')) queueMicrotask(open);
    else stop();
  });
  pauseBtn.addEventListener("click", () => ((auto = !auto), paintPause(), kick()));
  new ResizeObserver(resize).observe(wrap);

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
  });
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", () => ((hover = -1), (drag = null), (canvas.style.cursor = ""), redraw()));
  canvas.addEventListener("keydown", onKey);
  card.addEventListener("click", onCard);

  const rebuild = () => ((bands = computeBands()), paintHead(), isOpen() && redraw());
  subscribe(["events"], rebuild);
  subscribe(["selectedId"], () => (paintCard(), redraw()));
  subscribe(["filters"], () => (paintCard(), redraw()));
  rebuild();
  paintPause();
}

function computeBands() {
  const out = Array.from({ length: N }, () => ({ total: 0, elevated: 0, critical: 0 }));
  for (const e of state.events) {
    const v = lat(e);
    if (v == null) continue;
    const b = out[latBand(v)];
    b.total++;
    if (e.tier === 1) b.elevated++;
    if (e.tier === 2) b.critical++;
  }
  return out;
}

// One sentence, computed from the data: the point of the picture.
function paintHead() {
  const total = bands.reduce((s, b) => s + b.total, 0);
  if (!total) return void (head.textContent = "No latitude in this data file.");
  const polar = state.events.filter((e) => lat(e) != null && Math.abs(lat(e)) >= 60).length;
  head.textContent = `${Math.round((polar / total) * 100)}% of encounters happen above 60° latitude, where near-polar orbits cross.`;
}

function paintPause() {
  pauseBtn.textContent = auto ? "Pause rotation" : "Rotate";
}

function paintCard() {
  if (picked < 0 || !bands[picked]?.total) {
    card.hidden = true;
    hint.hidden = false;
    return;
  }
  const b = bands[picked], below = b.total - b.elevated - b.critical;
  const sel = state.events.find((e) => e.event_id === state.selectedId);
  const here = sel && lat(sel) != null && latBand(lat(sel)) === picked;
  const on = state.filters.lat === picked;
  const row = (t, n) => `<div class="gc-row"><span style="color:${TIERS[t].color}">${TIERS[t].icon}</span><span>${TIERS[t].name}</span><span class="num">${n.toLocaleString("en")}</span></div>`;
  card.innerHTML = `
    <button type="button" class="gc-close" data-act="close" aria-label="Close band detail">×</button>
    <h3>${esc(bandName(picked))}</h3>
    <p class="gc-sub num">${b.total.toLocaleString("en")} encounters · ${Math.round((b.critical / b.total) * 100)}% Critical</p>
    ${row(2, b.critical)}${row(1, b.elevated)}${row(0, below)}
    ${here ? `<p class="gc-sel">Selected event ${esc(sel.event_id)} is in this band.</p>` : ""}
    <button type="button" class="gc-filter" data-act="filter">${on ? "Clear queue filter" : "Show these in the queue"}</button>`;
  card.hidden = false;
  hint.hidden = true;
}

function onCard(ev) {
  const act = ev.target.closest("[data-act]")?.dataset.act;
  if (act === "close") pick(-1);
  if (act === "filter") {
    state.filters.lat = state.filters.lat === picked ? null : picked;
    touchFilters();
  }
}

function pick(i) {
  picked = i;
  paintCard();
  if (i >= 0) stop(); // hold still while a band is open
  else kick();
  redraw();
}

function onKey(ev) {
  if (ev.key === "Escape") return pick(-1);
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    return pick(picked >= 0 ? picked : bands.findIndex((b) => b.total));
  }
  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
  ev.preventDefault();
  const dir = ev.key === "ArrowUp" ? 1 : -1;
  for (let i = (picked < 0 ? (dir > 0 ? -1 : N) : picked) + dir; i >= 0 && i < N; i += dir) {
    if (bands[i].total) return pick(i);
  }
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
        land = null; // no outlines offline; the bands still draw
      }
    } catch (err) {
      ready = false;
      head.textContent = `Globe library failed to load (${err.message}).`;
      return;
    }
  }
  resize();
  kick();
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

function kick() {
  if (!isOpen() || !d3) return;
  draw();
  if (auto && picked < 0 && !raf) {
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  if (!auto) stop();
}

function loop(now) {
  raf = 0;
  if (!isOpen() || !auto || picked >= 0) return;
  if (!drag) rot = (rot + ((now - last) / 1000) * 6) % 360;
  last = now;
  draw();
  raf = requestAnimationFrame(loop);
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

const projection = () => d3.geoOrthographic().fitExtent([[56, 64], [w - 56, h - 56]], { type: "Sphere" }).rotate([rot, -tilt]).clipAngle(90);
const parallel = (deg) => ({ type: "LineString", coordinates: d3.range(-180, 181, 3).map((l) => [l, deg]) });

function draw() {
  if (!d3 || !w) return;
  ctx.clearRect(0, 0, w, h);
  const proj = projection(), path = d3.geoPath(proj, ctx);
  const [cx, cy] = proj.translate(), R = proj.scale();

  ctx.beginPath(); path({ type: "Sphere" });
  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  g.addColorStop(0, "#0f1815"); g.addColorStop(1, "#080b0a");
  ctx.fillStyle = g; ctx.fill();

  ctx.save();
  ctx.beginPath(); path({ type: "Sphere" }); ctx.clip();

  // density: one neutral shade per band, brighter = more encounters. Each band is a true area (d3's own latitude-band
  // outline), so it curves with the sphere instead of clipping into wedges at the limb.
  const max = Math.max(1, ...bands.map((b) => b.total));
  bands.forEach((b, i) => {
    if (!b.total && hover !== i && picked !== i) return;
    const lo = i * LAT_BAND - 90, hi = lo + LAT_BAND;
    const a = 0.05 + 0.5 * Math.sqrt(b.total / max) + (hover === i ? 0.1 : 0) + (picked === i ? 0.14 : 0);
    ctx.beginPath();
    path(d3.geoGraticule().extentMajor([[-180, lo], [180, hi]]).outline());
    ctx.fillStyle = `rgba(${SHADE},${a.toFixed(3)})`;
    ctx.fill();
  });

  if (land) {
    ctx.beginPath(); path(land);
    ctx.strokeStyle = "rgba(230,235,232,.30)"; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // the selected event's own latitude: a single thin line, no label (the band card names it)
  const sel = state.events.find((e) => e.event_id === state.selectedId);
  if (sel && lat(sel) != null) {
    ctx.beginPath(); path(parallel(lat(sel)));
    ctx.lineWidth = 1.2; ctx.strokeStyle = OWN; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();

  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "#2a3532"; ctx.lineWidth = 1; ctx.stroke();
}

// Band index under the pointer, or -1 off the sphere.
function bandAt(ev) {
  const r = canvas.getBoundingClientRect();
  const q = projection().invert([ev.clientX - r.left, ev.clientY - r.top]);
  return q && Number.isFinite(q[1]) ? latBand(q[1]) : -1;
}

function onMove(ev) {
  if (!d3) return;
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = ev.clientX; drag.y = ev.clientY;
    rot = (rot + dx * 0.4) % 360;
    tilt = Math.max(-80, Math.min(80, tilt + dy * 0.3));
    redraw();
    return;
  }
  const i = bandAt(ev);
  const next = i >= 0 && bands[i]?.total ? i : -1;
  canvas.style.cursor = next >= 0 ? "pointer" : "";
  if (next !== hover) { hover = next; redraw(); }
}

function onUp(ev) {
  const wasClick = drag && drag.moved < 4;
  drag = null;
  if (!wasClick) return;
  const i = bandAt(ev);
  pick(i >= 0 && bands[i]?.total && i !== picked ? i : -1);
}
