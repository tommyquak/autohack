// Triage funnel: every event as a dot, x = days to closest approach (shrinks as the replay clock runs), y = miss distance.
// Colour is the tier. The baseline/model toggle fades the dots the model demotes, so the workload drop is visible.
import { MAX_DAYS, TIERS, clamp, esc, fmtDays, fmtDist, fmtPc, lerp, mix, pct } from "./fmt.js";
import { passesFilters, remaining, set, state, subscribe } from "./state.js";

const canvas = document.getElementById("funnel");
const wrap = document.getElementById("funnel-wrap");
const tip = document.getElementById("tip");
const ctx = canvas.getContext("2d");
const M = { l: 62, r: 22, t: 14, b: 40 };
const Y_MIN = Math.log10(0.03), Y_MAX = Math.log10(100); // km
const GRID = getComputedStyle(document.documentElement).getPropertyValue("--hair").trim() || "#1b2220";
const MUTED = "#7d8a85";
const MONO = '11px "Spline Sans Mono", ui-monospace, monospace';

let w = 0, h = 0, dpr = 1;
let pts = [];
let progress = 1; // 0 = baseline tiers, 1 = model tiers
let target = 1;
let hover = null;
let dirty = true;
let lastT = performance.now();

const X = (days) => M.l + (1 - clamp(days, 0, MAX_DAYS + 0.4) / (MAX_DAYS + 0.4)) * (w - M.l - M.r);
const Y = (km) => M.t + (1 - (Math.log10(km) - Y_MIN) / (Y_MAX - Y_MIN)) * (h - M.t - M.b);

export function initFunnel() {
  pts = state.events.map((e) => ({ e, km: Math.max(e.latest.miss_distance_m / 1000, 0.03) }));
  new ResizeObserver(resize).observe(wrap);
  resize();

  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", () => {
      set({ mode: b.dataset.mode });
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }),
  );
  subscribe(["mode"], () => {
    target = state.mode === "model" ? 1 : 0;
    dirty = true;
  });
  subscribe(["elapsed", "filters", "selectedId"], () => (dirty = true));
  subscribe(["elapsed", "events"], updateWorkload);
  updateWorkload();

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", () => ((hover = null), (tip.hidden = true), (dirty = true)));
  canvas.addEventListener("click", () => hover && set({ selectedId: hover.e.event_id }));
  requestAnimationFrame(loop);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  w = wrap.clientWidth;
  h = wrap.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (progress !== target) {
    const step = dt / 0.9; // 0.9 s morph
    progress = target > progress ? Math.min(target, progress + step) : Math.max(target, progress - step);
    dirty = true;
    updateWorkload();
  }
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(loop);
}

const shownTier = (e) => (progress >= 0.5 ? e.tier : e.baseline_tier);

function draw() {
  ctx.clearRect(0, 0, w, h);
  const x0 = X(MAX_DAYS + 0.4), x1 = X(0), yTop = Y(100), yBot = Y(0.03);
  const y1 = Y(1), y5 = Y(5);

  // threshold bands
  ctx.fillStyle = "rgba(255,74,61,.06)";
  ctx.fillRect(x0, y1, x1 - x0, yBot - y1);
  ctx.fillStyle = "rgba(232,163,60,.05)";
  ctx.fillRect(x0, y5, x1 - x0, y1 - y5);
  // next-24h window
  ctx.fillStyle = "rgba(94,169,255,.07)";
  ctx.fillRect(X(1), yTop, x1 - X(1), yBot - yTop);

  // grid + axes
  ctx.font = MONO;
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const km of [0.05, 0.1, 0.5, 1, 5, 10, 50]) {
    const y = Y(km);
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(km >= 1 ? `${km} km` : `${km * 1000} m`, x0 - 8, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let d = 0; d <= MAX_DAYS; d++) {
    const x = X(d);
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(d === 0 ? "TCA" : `${d} d`, x, yBot + 8);
  }
  ctx.fillStyle = MUTED;
  ctx.fillText("DAYS TO CLOSEST APPROACH  →", (x0 + x1) / 2, yBot + 24);
  ctx.save();
  ctx.translate(14, (yTop + yBot) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("MISS DISTANCE (LOG)", 0, 0);
  ctx.restore();

  // thresholds
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  for (const [y, c, label] of [[y1, TIERS[2].color, "1 KM · CRITICAL"], [y5, TIERS[1].color, "5 KM · ELEVATED"]]) {
    ctx.strokeStyle = c;
    ctx.globalAlpha = 0.75;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x0 + 8, y - 4);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#5ea9ff";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("NEXT 24 H", x1 - 6, yTop + 6);

  // dots: tier 0 first so Critical sits on top
  for (let tier = 0; tier <= 2; tier++) {
    for (const p of pts) {
      const e = p.e, r = remaining(e);
      if (r <= 0 || shownTier(e) !== tier) continue;
      const on = passesFilters(e);
      const demoted = e.baseline_tier !== e.tier;
      // Fade a demoted dot from its baseline colour to its model colour as `progress` goes 0 -> 1.
      const color = demoted ? mix(TIERS[e.baseline_tier].color, TIERS[e.tier].color, progress) : TIERS[e.tier].color;
      const size = demoted ? lerp(3.4, 2.2, progress) : tier === 2 ? 3.8 : 2.6;
      ctx.globalAlpha = on ? (tier === 0 ? 0.55 : 0.92) : 0.08;
      ctx.fillStyle = color;
      const x = X(r), y = Y(p.km);
      ctx.beginPath(); ctx.arc(x, y, size, 0, 6.2832); ctx.fill();
      if (e.needs_review && on) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = TIERS[1].color;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, size + 2.4, 0, 6.2832); ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  // selected + hover rings
  for (const [p, c] of [[pts.find((q) => q.e.event_id === state.selectedId), "#5ea9ff"], [hover, "#e6ebe8"]]) {
    if (!p || remaining(p.e) <= 0) continue;
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(X(remaining(p.e)), Y(p.km), 8, 0, 6.2832); ctx.stroke();
  }
}

function onMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  let best = null, bd = 100; // 10 px radius, squared
  for (const p of pts) {
    const r = remaining(p.e);
    if (r <= 0 || !passesFilters(p.e)) continue;
    const dx = X(r) - mx, dy = Y(p.km) - my, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = p; }
  }
  if (best !== hover) { hover = best; dirty = true; }
  if (!best) { tip.hidden = true; return; }
  const e = best.e, L = e.latest, t = TIERS[shownTier(e)];
  tip.innerHTML = `<b style="color:${t.color}">${t.icon} ${t.name}</b> · EVT ${esc(e.event_id)}<br>` +
    `${fmtDist(L.miss_distance_m)} · TCA in ${fmtDays(remaining(e))}<br>Pc ≤ ${fmtPc(L.max_risk_estimate_log10)} · ${esc(L.object_type.toLowerCase())}` +
    (e.baseline_tier !== e.tier ? `<br><span style="color:#7d8a85">rule: ${TIERS[e.baseline_tier].name} → model: ${TIERS[e.tier].name}</span>` : "");
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(mx + 14, w - tw - 4)}px`;
  tip.style.top = `${Math.max(4, my - 10 - tip.offsetHeight)}px`;
}

// Event-level counts for the events still upcoming, tweened with the toggle.
function updateWorkload() {
  const up = state.events.filter((e) => remaining(e) > 0);
  const flag = (key) => up.filter((e) => e[key] > 0).length;
  const base = flag("baseline_tier"), model = flag("tier");
  const crit = up.filter((e) => e.tier === 2).length;
  const shown = Math.round(lerp(base, model, progress));
  const m = state.metrics?.results?.model;
  const el = document.getElementById("workload");
  el.innerHTML =
    `<span>Flagged for review <b class="num">${shown.toLocaleString("en")}</b> ` +
    `<span class="down">${model < base ? `−${(base - model).toLocaleString("en")} vs rule` : ""}</span></span>` +
    `<span>Critical kept <b class="num">${crit.toLocaleString("en")}</b></span>` +
    (m ? `<span>Critical recall <b class="num">${pct(m.critical_recall)}</b> <span class="muted">on ${m.n.toLocaleString("en")} test CDMs</span></span>` : "");
  const empty = document.getElementById("funnel-empty");
  empty.hidden = up.length > 0;
  empty.textContent = "Every event has passed closest approach. Press Reset on the replay clock.";
  document.getElementById("funnel-note").textContent =
    (state.elapsed > 0 ? "REPLAY: each event's latest prediction carried forward in time; no new CDMs arrive. " : "") +
    "Position shows distance only: Pc also sets the tier, so a dot above 5 km can still be Critical. Rings mark events needing review.";
}
