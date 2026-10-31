// Globe tab: where encounters happen, by REAL conjunction-point latitude, in front of an illustrative sky.
//
// What is data:   each event's LATITUDE (CDM geocentric_latitude). Every event is a dot coloured by its tier.
//                 The CDM files have no longitude, so a dot's east-west position is arbitrary: a fixed spread from the
//                 event id (golden angle), so dots are stable between loads. The key and hint say so.
//                 Click a dot to select the event, or a band for its counts.
// What is not:    the stars, the orbiting debris and the continents' lighting. The debris positions are made up for the
//                 picture; only its colour mix follows the real chaser types in the events. The key says so.
// Also real:      the blue ring sits at the median target altitude (events' `target_altitude_km`) on a near-polar orbit,
//                 which is what the targets fly (inclination 87-99 deg in the CDMs); its longitude is arbitrary.
//
// d3 and topojson load the first time the tab opens; offline, the globe still draws without land outlines.
import { LAT_BAND, TIERS, esc, latBand } from "./fmt.js";
import { passesFilters, remaining, set, state, subscribe, touchFilters } from "./state.js";

const D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const TOPO = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js";
const LAND = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json";
const N = 180 / LAT_BAND;
const OWN = "#5ea9ff";
// Chaser types and their dot colours; the particle mix is sampled from the real counts.
const KINDS = [
  { type: "DEBRIS", label: "Debris", color: "#b9a38f", size: 1.6 },
  { type: "PAYLOAD", label: "Payload", color: "#f2f6f4", size: 2 },
  { type: "ROCKET BODY", label: "Rocket body", color: "#a596ff", size: 2.2 },
  { type: "UNKNOWN", label: "Unidentified", color: "#8a9490", size: 1.6 },
];
const PARTICLES = 2400;

let canvas, ctx, wrap, card, head, hint, pauseBtn, d3, land = null;
let w = 0, h = 0, dpr = 1;
let rot = 20, tilt = 24; // spin and tilt toward the viewer, degrees
let auto = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let bands = [], dots = [];
let hoverDot = null;
let hover = -1, picked = -1;
let drag = null;
let raf = 0, last = 0, clock = 0, ready = false;
let stars = [], parts = null, orbitR = 1.08;

// One drawn chevron (points left); the right-hand handle is the same shape flipped by CSS.
const CHEV = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>`;
const panel = () => document.getElementById("panel-globe");
const isOpen = () => panel() && !panel().hidden;
const lat = (e) => e.latest.geocentric_latitude_deg;
const edge = (v) => `${Math.abs(v)}°${v < 0 ? " S" : v > 0 ? " N" : ""}`;
const bandName = (i) => `${edge(i * LAT_BAND - 90)} to ${edge(i * LAT_BAND - 90 + LAT_BAND)}`;
const rad = (d) => (d * Math.PI) / 180;

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

  document.getElementById("tabs").firstElementChild.insertAdjacentHTML("afterend", `<button role="tab" aria-selected="false" data-tab="globe">Globe</button>`);
  document.getElementById("panel-eval").insertAdjacentHTML(
    "afterend",
    `<div class="panel" id="panel-globe" role="tabpanel" hidden>
      <div class="canvas-wrap" id="globe-wrap">
        <canvas id="globe" tabindex="0" aria-label="Globe of encounters by latitude band. Arrow up and down move between bands, Enter opens one."></canvas>
        <p class="globe-head" id="globe-head"></p>
        <button type="button" class="globe-pause" id="globe-pause"></button>
        <div class="globe-key" id="globe-key"></div>
        <p class="globe-hint" id="globe-hint">Each dot is one event at its real latitude. The data has no longitude, so a dot's east-west position is arbitrary. Click a dot or a band for detail.</p>
        <div class="globe-tip" id="globe-tip" hidden></div>
        <section class="globe-card" id="globe-card" hidden aria-live="polite"></section>
        <button type="button" class="rail-toggle left" id="rail-l" aria-expanded="true" aria-label="Collapse the events panel" title="Collapse the events panel">${CHEV}</button>
        <button type="button" class="rail-toggle right" id="rail-r" aria-expanded="true" aria-label="Collapse the selected-event panel" title="Collapse the selected-event panel">${CHEV}</button>
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
  // The side panels only collapse while the globe is showing (layout[data-view="globe"] in dashboard.css), so the other
  // tabs always keep them; the collapsed state is remembered for the next visit to the globe.
  const layout = document.querySelector(".layout");
  layout.dataset.view = document.querySelector('#tabs [aria-selected="true"]')?.dataset.tab || "";
  document.getElementById("tabs").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tab]");
    if (btn) layout.dataset.view = btn.dataset.tab;
    if (ev.target.closest('[data-tab="globe"]')) queueMicrotask(open);
    else stop();
  });
  for (const [id, cls, name] of [["rail-l", "hide-left", "events"], ["rail-r", "hide-right", "selected-event"]]) {
    const b = document.getElementById(id);
    b.addEventListener("click", () => {
      const hidden = layout.classList.toggle(cls);
      b.setAttribute("aria-expanded", String(!hidden));
      b.setAttribute("aria-label", `${hidden ? "Expand" : "Collapse"} the ${name} panel`);
      b.title = b.getAttribute("aria-label");
    });
  }
  pauseBtn.addEventListener("click", () => ((auto = !auto), paintPause(), kick()));
  new ResizeObserver(resize).observe(wrap);

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
  });
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", () => ((hover = -1), (hoverDot = null), (drag = null), (canvas.style.cursor = ""), paintTip(null), redraw()));
  canvas.addEventListener("keydown", onKey);
  card.addEventListener("click", onCard);

  const rebuild = () => {
    bands = computeBands();
    dots = buildDots();
    buildSky();
    paintHead();
    paintKey();
    if (isOpen()) redraw();
  };
  subscribe(["events"], rebuild);
  subscribe(["selectedId", "filters"], () => (paintCard(), redraw()));
  rebuild();
  paintPause();
}

// One dot per event: real latitude, arbitrary but fixed longitude (golden-angle spread by event id).
function buildDots() {
  return state.events.filter((e) => lat(e) != null).map((e) => ({ e, lat: lat(e), lon: ((e.event_id * 137.50776405) % 360) - 180 }));
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

// Stars, debris and the target ring. Seeded, so the sky is the same on every load.
function buildSky() {
  const rnd = prng(7);
  stars = Array.from({ length: 460 }, () => ({ x: rnd(), y: rnd(), r: 0.3 + rnd() ** 3 * 1.3, a: 0.22 + rnd() * 0.6, p: rnd() * 6.28, s: 0.5 + rnd() * 1.6, warm: rnd() < 0.2 }));

  // particle colour mix follows the events' real chaser types
  const counts = KINDS.map((k) => state.events.filter((e) => (k.type === "UNKNOWN" ? e.latest.object_type === "UNKNOWN" || e.latest.object_type === "TBA" : e.latest.object_type === k.type)).length);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const weights = counts.some(Boolean) ? counts.map((c) => c / total) : [0.58, 0.1, 0.02, 0.3];
  const pick = () => {
    let u = rnd(), i = 0;
    while (i < weights.length - 1 && u > weights[i]) u -= weights[i++];
    return i;
  };
  const list = Array.from({ length: PARTICLES }, () => {
    const rr = 1.07 + rnd() ** 1.7 * 0.95; // dense near the surface, thinning outward
    const polar = rnd() < 0.6;
    return {
      rr,
      inc: rad(polar ? 82 + rnd() * 20 : rnd() * 180),
      node: rnd() * 6.2832,
      phase: rnd() * 6.2832,
      omega: 0.16 * (1.1 / rr) ** 1.5 * (rnd() < 0.5 ? 1 : -1),
      kind: pick(),
    };
  }).sort((a, b) => a.kind - b.kind);
  parts = { list, pos: new Float32Array(PARTICLES * 3) };

  const alts = state.events.map((e) => e.latest.target_altitude_km).filter((a) => a && a[0] != null).map((a) => (a[0] + a[1]) / 2).sort((a, b) => a - b);
  orbitR = 1 + (alts.length ? alts[Math.floor(alts.length / 2)] : 700) / 6371;
}

// One sentence, computed from the data: the point of the picture.
function paintHead() {
  const total = bands.reduce((s, b) => s + b.total, 0);
  if (!total) return void (head.textContent = "No latitude in this data file.");
  const polar = state.events.filter((e) => lat(e) != null && Math.abs(lat(e)) >= 60).length;
  head.textContent = `${Math.round((polar / total) * 100)}% of encounters happen above 60° latitude, where near-polar orbits cross.`;
}

function paintKey() {
  document.getElementById("globe-key").innerHTML = `
    <div class="gk-title">Events, at their real latitude</div>
    ${[2, 1, 0].map((t) => `<div class="gk-row"><i style="background:${TIERS[t].color}"></i>${esc(TIERS[t].name)}</div>`).join("")}
    <div class="gk-note">Longitude is not in the data, so east-west position is arbitrary.</div>
    <div class="gk-title gk-sep">Illustrative traffic, not data</div>
    ${KINDS.map((k) => `<div class="gk-row"><i style="background:${k.color}"></i>${esc(k.label)}</div>`).join("")}
    <div class="gk-row"><i class="gk-ring"></i>Typical target orbit</div>`;
}

function paintPause() {
  pauseBtn.textContent = auto ? "Pause motion" : "Play motion";
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
  if (auto && !raf) {
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  if (!auto) stop();
}

function loop(now) {
  raf = 0;
  if (!isOpen() || !auto) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  if (picked < 0 && !drag) rot = (rot + dt * 6) % 360; // the globe holds still while a band is open; the sky keeps drifting
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

// Leave room around the sphere for the debris shells.
const projection = () => {
  const pad = Math.max(28, Math.min(w, h) * 0.1);
  return d3.geoOrthographic().fitExtent([[pad, pad + 24], [w - pad, h - pad]], { type: "Sphere" }).rotate([rot, -tilt]).clipAngle(90);
};
const parallel = (deg) => ({ type: "LineString", coordinates: d3.range(-180, 181, 3).map((l) => [l, deg]) });

// 3D helpers shared by debris and the target ring: orbit-frame point -> view (x right, y up, z toward viewer).
function view(x, y, z) {
  const yaw = rad(rot), c = Math.cos(yaw), s = Math.sin(yaw);
  const x2 = x * c - y * s, y2 = x * s + y * c;
  const p = rad(tilt), cp = Math.cos(p), sp = Math.sin(p);
  const toward = -y2;
  return [x2, z * cp - toward * sp, z * sp + toward * cp];
}
function onOrbit(rr, inc, node, theta) {
  const x = rr * Math.cos(theta), y0 = rr * Math.sin(theta);
  const y = y0 * Math.cos(inc), z = y0 * Math.sin(inc);
  return [x * Math.cos(node) - y * Math.sin(node), x * Math.sin(node) + y * Math.cos(node), z];
}

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

// back = pass behind the globe (drawn first, hidden where the disc covers it); otherwise in front.
function drawDebris(back, cx, cy, R) {
  const { list, pos } = parts;
  let kind = -1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const o = onOrbit(p.rr, p.inc, p.node, p.phase + p.omega * clock);
    const [vx, vy, vz] = view(o[0], o[1], o[2]);
    pos[i * 3] = vx; pos[i * 3 + 1] = vy; pos[i * 3 + 2] = vz;
    const behind = vz < 0;
    if (behind !== back) continue;
    if (behind && vx * vx + vy * vy < 1) continue; // hidden by the planet
    if (p.kind !== kind) { kind = p.kind; ctx.fillStyle = KINDS[kind].color; }
    ctx.globalAlpha = back ? 0.32 : 0.5;
    const s = KINDS[kind].size;
    ctx.fillRect(cx + vx * R - s / 2, cy - vy * R - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function drawRing(back, cx, cy, R) {
  const inc = rad(98), node = rad(40), n = 160;
  ctx.lineWidth = back ? 1 : 1.5;
  ctx.strokeStyle = back ? "rgba(150,205,255,.28)" : "rgba(150,205,255,.85)";
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i <= n; i++) {
    const o = onOrbit(orbitR, inc, node, (i / n) * 6.2832);
    const [vx, vy, vz] = view(o[0], o[1], o[2]);
    const behind = vz < 0, hidden = behind && vx * vx + vy * vy < 1;
    if (behind !== back || hidden) { pen = false; continue; }
    const x = cx + vx * R, y = cy - vy * R;
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
  if (!back) {
    const o = onOrbit(orbitR, inc, node, clock * 0.5);
    const [vx, vy, vz] = view(o[0], o[1], o[2]);
    if (vz >= 0 || vx * vx + vy * vy >= 1) {
      ctx.fillStyle = "#cfe8ff";
      ctx.beginPath(); ctx.arc(cx + vx * R, cy - vy * R, 2.6, 0, 6.2832); ctx.fill();
    }
  }
}

function draw() {
  if (!d3 || !w) return;
  ctx.clearRect(0, 0, w, h);
  drawStars();

  const proj = projection(), path = d3.geoPath(proj, ctx);
  const [cx, cy] = proj.translate(), R = proj.scale();

  drawDebris(true, cx, cy, R);
  drawRing(true, cx, cy, R);

  // atmosphere: a soft blue rim just outside the limb
  const atm = ctx.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.16);
  atm.addColorStop(0, "rgba(96,176,255,.42)"); atm.addColorStop(0.35, "rgba(70,140,230,.14)"); atm.addColorStop(1, "rgba(60,120,220,0)");
  ctx.fillStyle = atm;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, 6.2832); ctx.fill();

  // ocean, lit from the upper left
  ctx.beginPath(); path({ type: "Sphere" });
  const sea = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.08, cx, cy, R * 1.02);
  sea.addColorStop(0, "#2a6aa3"); sea.addColorStop(0.55, "#12395f"); sea.addColorStop(1, "#071a2e");
  ctx.fillStyle = sea; ctx.fill();

  ctx.save();
  ctx.beginPath(); path({ type: "Sphere" }); ctx.clip();

  if (land) {
    ctx.beginPath(); path(land);
    ctx.fillStyle = "rgba(46,124,98,.62)"; ctx.fill();
  }

  // only the band under the pointer, or the one that is open, is shaded
  for (const i of new Set([hover, picked])) {
    if (i < 0) continue;
    const lo = i * LAT_BAND - 90;
    ctx.beginPath();
    path(d3.geoGraticule().extentMajor([[-180, lo], [180, lo + LAT_BAND]]).outline());
    ctx.fillStyle = `rgba(230,240,255,${i === picked ? 0.2 : 0.1})`;
    ctx.fill();
  }

  if (land) {
    ctx.beginPath(); path(land);
    ctx.strokeStyle = "rgba(200,245,225,.6)"; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // night-side shading for depth
  const shade = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, R * 0.3, cx, cy, R * 1.05);
  shade.addColorStop(0, "rgba(0,0,0,0)"); shade.addColorStop(1, "rgba(2,6,14,.62)");
  ctx.fillStyle = shade; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  drawDots(path);
  ctx.restore();

  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(140,200,255,.35)"; ctx.lineWidth = 1; ctx.stroke();

  drawRing(false, cx, cy, R);
  drawDebris(false, cx, cy, R);
}

// Events as dots, tier-coloured; Critical drawn last so it stays on top. Filters dim the dots they exclude.
const DOT = [2, 2.9, 3.8]; // radius by tier
function drawDots(path) {
  for (let tier = 0; tier <= 2; tier++) {
    ctx.fillStyle = TIERS[tier].color;
    ctx.strokeStyle = "rgba(4,10,18,.85)";
    ctx.lineWidth = 0.8;
    path.pointRadius(DOT[tier]);
    for (const d of dots) {
      if (d.e.tier !== tier || remaining(d.e) <= 0) continue;
      ctx.globalAlpha = passesFilters(d.e) ? 0.95 : 0.1;
      ctx.beginPath();
      path({ type: "Point", coordinates: [d.lon, d.lat] });
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const sel = dots.find((d) => d.e.event_id === state.selectedId);
  if (sel && remaining(sel.e) > 0) {
    ctx.strokeStyle = OWN;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    path.pointRadius(8);
    path({ type: "Point", coordinates: [sel.lon, sel.lat] });
    ctx.stroke();
  }
}

// Nearest visible dot within 9 px of the pointer, or null.
function dotAt(ev) {
  const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const proj = projection();
  let best = null, bd = 81;
  for (const d of dots) {
    if (remaining(d.e) <= 0 || !passesFilters(d.e)) continue;
    const p = proj([d.lon, d.lat]);
    if (!p) continue; // far side of the globe
    const dist = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}

function paintTip(d, ev) {
  const tip = document.getElementById("globe-tip");
  if (!d) { tip.hidden = true; return; }
  const r = canvas.getBoundingClientRect(), t = TIERS[d.e.tier];
  tip.innerHTML = `<b style="color:${t.color}">${t.icon} ${esc(t.name)}</b> · EVT ${esc(d.e.event_id)}<br>${Math.abs(d.lat).toFixed(1)}° ${d.lat < 0 ? "S" : "N"}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(4, ev.clientY - r.top - 12 - tip.offsetHeight)}px`;
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
  const d = dotAt(ev);
  if (d !== hoverDot) { hoverDot = d; paintTip(d, ev); }
  else if (d) paintTip(d, ev);
  const i = d ? -1 : bandAt(ev);
  const next = i >= 0 && bands[i]?.total ? i : -1;
  canvas.style.cursor = d || next >= 0 ? "pointer" : "";
  if (next !== hover) { hover = next; redraw(); }
}

function onUp(ev) {
  const wasClick = drag && drag.moved < 4;
  drag = null;
  if (!wasClick) return;
  const d = dotAt(ev);
  if (d) return set({ selectedId: d.e.event_id }); // the detail panel follows; the dot gets a ring
  const i = bandAt(ev);
  pick(i >= 0 && bands[i]?.total && i !== picked ? i : -1);
}
