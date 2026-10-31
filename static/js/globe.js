// Globe tab: where encounters happen, by REAL conjunction-point latitude.
//
// Data honesty: the CDM files carry `geocentric_latitude` per event and NO longitude (train/test CSV and the .xlsx all have
// the same 103 columns). So nothing is pinned to a map point. Each 5-degree latitude band is drawn as a ring whose
// brightness is the number of events in it (red core = Critical). Continents are decoration for orientation only.
//
// d3 and topojson load the first time the tab opens; if the CDN is unreachable the globe still draws without land.
import { TIERS, esc } from "./fmt.js";
import { set, state, subscribe, touchFilters } from "./state.js";

const D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const TOPO = "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js";
const LAND = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json";
const BAND = 5; // degrees of latitude per ring
const GRATICULE = "#1b2623", LANDFILL = "#0f1a16", LANDLINE = "#22302b", INK = "#e6ebe8", OWN = "#5ea9ff";

let canvas, ctx, wrap, readout, d3, land = null;
let w = 0, h = 0, dpr = 1;
let rot = 20, tilt = 22; // longitude spin and tilt toward the viewer
let auto = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let bands = [];
let hoverBand = -1;
let drag = null;
let raf = 0, last = 0, ready = false;

const panel = () => document.getElementById("panel-globe");
const isOpen = () => panel() && !panel().hidden;
const lat = (e) => e.latest.geocentric_latitude_deg;
const bandOf = (deg) => Math.min(180 / BAND - 1, Math.max(0, Math.floor((deg + 90) / BAND)));
const bandName = (i) => {
  const lo = i * BAND - 90, hi = lo + BAND;
  const f = (v) => `${Math.abs(v)}°${v < 0 ? " S" : v > 0 ? " N" : ""}`;
  return `${f(lo)} to ${f(hi)}`;
};

export function initGlobe() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/globe.css" });
  document.head.append(css);

  const tabs = document.getElementById("tabs");
  tabs.firstElementChild.insertAdjacentHTML("afterend", `<button role="tab" aria-selected="false" data-tab="globe">Globe</button>`);
  document.getElementById("panel-funnel").insertAdjacentHTML(
    "afterend",
    `<div class="panel" id="panel-globe" role="tabpanel" hidden>
      <div class="stage-bar">
        <div class="globe-key" aria-label="Key">
          <span><i class="k-ev"></i> Events in a ${BAND}° latitude band (brighter = more)</span>
          <span><i class="k-crit"></i> Critical</span>
          <span><i class="k-sel"></i> Selected event</span>
        </div>
        <label class="check"><input type="checkbox" id="globe-auto" ${auto ? "checked" : ""}> Auto-rotate</label>
      </div>
      <div class="canvas-wrap" id="globe-wrap">
        <canvas id="globe" aria-label="Globe of events by conjunction latitude band"></canvas>
        <div class="globe-read" id="globe-read" aria-live="polite">Hover a band. Click to filter the queue to it.</div>
      </div>
      <p class="note" id="globe-note"></p>
    </div>`,
  );
  wrap = document.getElementById("globe-wrap");
  canvas = document.getElementById("globe");
  ctx = canvas.getContext("2d");
  readout = document.getElementById("globe-read");

  // Tab switching itself is the generic data-tab handler in encounter.js; here we only start drawing on open.
  tabs.addEventListener("click", (ev) => {
    if (ev.target.closest('[data-tab="globe"]')) queueMicrotask(open);
    else stop();
  });
  document.getElementById("globe-auto").addEventListener("change", (ev) => ((auto = ev.target.checked), kick()));
  new ResizeObserver(resize).observe(wrap);

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
  });
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", () => ((hoverBand = -1), (drag = null), paintReadout(), draw()));

  const rebuild = () => ((bands = computeBands()), isOpen() && draw());
  subscribe(["events"], rebuild);
  subscribe(["selectedId", "filters"], () => isOpen() && draw());
  rebuild();
  document.getElementById("globe-note").textContent =
    "Real data: latitude of each event's closest-approach point (CDM geocentric_latitude). The data has no longitude, so no event is pinned " +
    "to a map location; continents are for orientation only. Most targets are near-polar orbits, so the bright rings sit at the poles.";
}

function computeBands() {
  const n = 180 / BAND;
  const out = Array.from({ length: n }, () => ({ total: 0, elevated: 0, critical: 0 }));
  for (const e of state.events) {
    const v = lat(e);
    if (v == null) continue;
    const b = out[bandOf(v)];
    b.total++;
    if (e.tier === 1) b.elevated++;
    if (e.tier === 2) b.critical++;
  }
  return out;
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
        land = null; // no continents offline; rings still draw
      }
    } catch (err) {
      ready = false;
      readout.textContent = `Globe library failed to load (${err.message}).`;
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
  if (!drag) rot = (rot + ((now - last) / 1000) * 7) % 360;
  last = now;
  draw();
  raf = requestAnimationFrame(loop);
}

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

const projection = () => d3.geoOrthographic().fitExtent([[24, 24], [w - 24, h - 24]], { type: "Sphere" }).rotate([rot, -tilt]).clipAngle(90);

function draw() {
  if (!d3 || !w) return;
  ctx.clearRect(0, 0, w, h);
  const proj = projection(), path = d3.geoPath(proj, ctx);
  const [cx, cy] = proj.translate(), R = proj.scale();

  // sphere
  ctx.beginPath(); path({ type: "Sphere" });
  const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  g.addColorStop(0, "#101a17"); g.addColorStop(1, "#080c0b");
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "#2a3532"; ctx.lineWidth = 1; ctx.stroke();

  ctx.save();
  ctx.beginPath(); path({ type: "Sphere" }); ctx.clip();
  if (land) {
    ctx.beginPath(); path(land);
    ctx.fillStyle = LANDFILL; ctx.fill();
    ctx.strokeStyle = LANDLINE; ctx.lineWidth = 0.7; ctx.stroke();
  }
  ctx.beginPath(); path(d3.geoGraticule10());
  ctx.strokeStyle = GRATICULE; ctx.lineWidth = 0.6; ctx.stroke();

  // latitude rings: brightness = events, red core = Critical
  const max = Math.max(1, ...bands.map((b) => b.total)), maxC = Math.max(1, ...bands.map((b) => b.critical));
  const px = R * ((BAND * Math.PI) / 180);
  bands.forEach((b, i) => {
    if (!b.total) return;
    const parallel = { type: "LineString", coordinates: d3.range(-180, 181, 3).map((l) => [l, i * BAND - 90 + BAND / 2]) };
    ctx.lineCap = "butt";
    ctx.beginPath(); path(parallel);
    ctx.lineWidth = px * 1.02;
    ctx.strokeStyle = `rgba(230,235,232,${(0.03 + 0.26 * Math.sqrt(b.total / max)).toFixed(3)})`;
    ctx.stroke();
    if (b.critical) {
      ctx.beginPath(); path(parallel);
      ctx.lineWidth = px * 0.3;
      ctx.strokeStyle = `rgba(255,74,61,${(0.12 + 0.62 * Math.sqrt(b.critical / maxC)).toFixed(3)})`;
      ctx.stroke();
    }
    if (state.filters.lat === i || hoverBand === i) {
      ctx.beginPath(); path(parallel);
      ctx.lineWidth = px * 0.96; ctx.strokeStyle = state.filters.lat === i ? OWN : INK; ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
    }
  });

  if (land) {
    ctx.beginPath(); path(land);
    ctx.strokeStyle = "rgba(230,235,232,.28)"; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // selected event: its real latitude as a parallel
  const sel = state.events.find((e) => e.event_id === state.selectedId);
  if (sel && lat(sel) != null) {
    ctx.beginPath();
    path({ type: "LineString", coordinates: d3.range(-180, 181, 3).map((l) => [l, lat(sel)]) });
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.6; ctx.strokeStyle = OWN; ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();

  if (sel && lat(sel) != null) {
    const p = proj([-rot, lat(sel)]);
    if (p) {
      ctx.font = '11px "Spline Sans Mono", ui-monospace, monospace';
      ctx.fillStyle = OWN; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText(`EVT ${sel.event_id} · ${Math.abs(lat(sel)).toFixed(1)}° ${lat(sel) < 0 ? "S" : "N"}`, p[0] + 8, p[1] - 4);
    }
  }
  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "#2a3532"; ctx.lineWidth = 1; ctx.stroke();
}

// Latitude under the pointer, or null off the sphere.
function latAt(ev) {
  const r = canvas.getBoundingClientRect();
  const q = projection().invert([ev.clientX - r.left, ev.clientY - r.top]);
  return q && Number.isFinite(q[1]) ? q[1] : null;
}

function onMove(ev) {
  if (!d3) return;
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = ev.clientX; drag.y = ev.clientY;
    rot = (rot + dx * 0.4) % 360;
    tilt = Math.max(-80, Math.min(80, tilt + dy * 0.3));
    draw();
    return;
  }
  const v = latAt(ev);
  const i = v == null ? -1 : bandOf(v);
  if (i !== hoverBand) { hoverBand = i; paintReadout(); draw(); }
}

function onUp() {
  const wasClick = drag && drag.moved < 4;
  drag = null;
  if (!wasClick || hoverBand < 0 || !bands[hoverBand]?.total) return;
  state.filters.lat = state.filters.lat === hoverBand ? null : hoverBand;
  touchFilters();
}

function paintReadout() {
  const b = bands[hoverBand];
  if (hoverBand < 0 || !b) { readout.textContent = "Hover a band. Click to filter the queue to it."; return; }
  readout.innerHTML = `<b>${esc(bandName(hoverBand))}</b> · ${b.total.toLocaleString("en")} events` +
    ` · <span style="color:${TIERS[1].color}">${b.elevated} elevated</span> · <span style="color:${TIERS[2].color}">${b.critical} critical</span>`;
}

export { bandName };
