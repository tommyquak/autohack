// Decision point: one chart, miss distance against time to TCA (7 d -> TCA).
// Left of the 2-day line: each event's real CDM updates as a thin track (the official task only allows messages
// >= 2 d out, and every update in this data is). Right of it: one mark per event in the zone of its forecast FINAL
// tier, read from event.forecast when the final-tier forecaster provides it, otherwise the current tier, labelled
// as a placeholder. Nothing here recomputes a tier.
import { api } from "./api.js";
import { TIERS, clamp, esc, fmtDays, fmtDist, fmtPc } from "./fmt.js";

const DECISION = 2; // days: the official task predicts from messages at least this far out
const X_MAX = 7;
const SAMPLE = { 2: 15, 1: 15, 0: 10 }; // default tracks per current tier, most urgent first, plus every escalation
const Y_MIN = -2, Y_MAX = 2; // log10 km: 10 m .. 100 km
const ZONES = [ // forecast tier zones on the right, bounded by the 1 km / 5 km thresholds
  { tier: 2, lo: 0.01, hi: 1, label: ["CRITICAL"] },
  { tier: 1, lo: 1, hi: 5, label: ["ELEVATED"] },
  { tier: 0, lo: 5, hi: 100, label: ["BELOW", "THRESHOLD"] },
];
const M = { l: 70, r: 116, t: 64, b: 42 };
const CSS = getComputedStyle(document.documentElement);
const tok = (name, fallback) => CSS.getPropertyValue(name).trim() || fallback;
const C = { ink: tok("--ink", "#e6ebe8"), muted: tok("--muted", "#7d8a85"), hair: tok("--hair", "#1b2220"), hair2: tok("--hair2", "#2a3532"), own: tok("--own", "#5ea9ff") };
const MONO = '11px "Spline Sans Mono", ui-monospace, monospace';
const MONO_B = '500 16px "Spline Sans Mono", ui-monospace, monospace';

const $ = (id) => document.getElementById(id);
const canvas = $("chart"), wrap = $("wrap"), tip = $("tip"), card = $("card"), main = $("main");
const ctx = canvas.getContext("2d");

let events = []; // urgency order (tier desc, then soonest TCA), from /api/events
const byId = new Map();
const rank = new Map(); // event_id -> urgency index
const hist = new Map(); // event_id -> [{t, km}] sorted far -> near
const marks = new Map(); // event_id -> {x, y, r}
let anyForecast = false;
let show = "sample";
let sample = [];
let selected = null, hover = null;
let w = 0, h = 0, pitch = 6;
let dirty = true;

const X = (d) => M.l + (1 - clamp(d, 0, X_MAX) / X_MAX) * (w - M.l - M.r);
const Y = (km) => M.t + (1 - (clamp(Math.log10(km), Y_MIN, Y_MAX) - Y_MIN) / (Y_MAX - Y_MIN)) * (h - M.t - M.b);

// event.forecast = {predicted_final_tier, p_final, ...}; p_final are class-weighted model scores, NOT calibrated probabilities.
function forecast(e) {
  const f = e.forecast;
  if (f && Number.isInteger(f.predicted_final_tier)) {
    const t = f.predicted_final_tier;
    const p = Array.isArray(f.p_final) ? f.p_final[t] : typeof f.p_final === "number" ? f.p_final : null;
    return { tier: t, p: Number.isFinite(p) ? p : null, real: true };
  }
  return { tier: e.tier, p: null, real: false };
}
const escalates = (e) => forecast(e).real && forecast(e).tier > e.tier;
const n = (v) => v.toLocaleString("en");

init().catch((err) => {
  $("counts").textContent = "";
  const empty = $("empty");
  empty.hidden = false;
  empty.textContent = err.message;
});

async function init() {
  const res = await api.events();
  events = res.events;
  events.forEach((e, i) => (byId.set(e.event_id, e), rank.set(e.event_id, i)));
  anyForecast = events.some((e) => forecast(e).real);
  buildSample();
  $("show-all").textContent = `All ${n(events.length)}`;
  $("show-sample").textContent = `Sample of ${n(sample.length)}`;
  renderCounts();
  renderHeads();

  new ResizeObserver(resize).observe(wrap);
  resize();
  canvas.tabIndex = 0;
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", () => ((hover = null), (tip.hidden = true), (dirty = true)));
  canvas.addEventListener("click", () => select(hover ? hover.e.event_id : null));
  canvas.addEventListener("keydown", onKey);
  document.addEventListener("keydown", (ev) => ev.key === "Escape" && selected != null && select(null));
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setShow(b.dataset.show)));
  requestAnimationFrame(loop);

  const fromHash = new URLSearchParams(location.hash.slice(1)).get("event");
  if (fromHash && byId.has(Number(fromHash))) select(Number(fromHash));
  await loadTracks(shownEvents().map((e) => e.event_id));
}

// ---------- data ----------

const shownEvents = () => (show === "all" ? events : sample);

// The default left side: a mixed sample instead of every track. Every escalation (once a forecast exists), then
// the most urgent Critical, Elevated and below-threshold events. Events are already in urgency order.
function buildSample() {
  const left = { ...SAMPLE };
  const picked = new Set(events.filter(escalates).map((e) => e.event_id));
  for (const e of events) {
    if (left[e.tier] > 0 && !picked.has(e.event_id)) (picked.add(e.event_id), left[e.tier]--);
  }
  sample = events.filter((e) => picked.has(e.event_id));
}

async function loadTracks(ids) {
  const todo = ids.filter((id) => !hist.has(id));
  if (!todo.length) return status("");
  let done = 0, failed = 0, i = 0;
  const buttons = document.querySelectorAll(".seg button");
  buttons.forEach((b) => (b.disabled = true));
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        await loadOne(id);
      } catch {
        failed++;
      }
      done++;
      if (done % 25 === 0 || done === todo.length) status(`Loading CDM updates ${n(done)} / ${n(todo.length)}`);
      dirty = true;
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  buttons.forEach((b) => (b.disabled = false));
  status(failed ? `${n(failed)} events' updates could not be loaded; their tracks are missing` : "");
}

async function loadOne(id) {
  if (hist.has(id)) return hist.get(id);
  const ev = await api.event(id);
  const pts = (ev.history || [])
    .map((u) => ({ t: u.time_to_tca_days, km: Math.max(u.miss_distance_m / 1000, 0.01), u }))
    .sort((a, b) => b.t - a.t);
  hist.set(id, pts);
  return pts;
}

function status(text) {
  $("status").textContent = text;
}

async function setShow(next) {
  if (next === show) return;
  show = next;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.show === show));
  renderHeads();
  dirty = true;
  await loadTracks(shownEvents().map((e) => e.event_id));
}

// ---------- text around the chart ----------

function renderCounts() {
  const cnt = (f) => events.filter(f).length;
  const nowC = cnt((e) => e.tier === 2), nowE = cnt((e) => e.tier === 1);
  let fc;
  if (anyForecast) {
    const missing = cnt((e) => !forecast(e).real);
    fc = `<b class="c">${n(cnt((e) => forecast(e).tier === 2))}</b> Critical · <b class="e">${n(cnt((e) => forecast(e).tier === 1))}</b> Elevated · <b>${n(cnt(escalates))}</b> escalations` +
      (missing ? ` <span class="why">(${n(missing)} without a forecast: current tier shown)</span>` : "");
  } else {
    fc = `<span class="why">pending the final-tier forecaster</span>`;
  }
  const in24 = cnt((e) => e.latest.time_to_tca_days <= 1);
  const soonest = Math.min(...events.map((e) => e.latest.time_to_tca_days));
  const w24 = in24
    ? `<b>${n(in24)}</b> <span class="why">within 1 d of TCA at the latest update</span>`
    : `<b>0</b> <span class="why">none within 1 d of TCA at its latest update (soonest ${fmtDays(soonest)})</span>`;
  $("counts").innerHTML =
    `<span class="grp"><span class="k">Now</span> <b class="c">${n(nowC)}</b> Critical · <b class="e">${n(nowE)}</b> Elevated</span>` +
    `<span class="to" aria-hidden="true">→</span>` +
    `<span class="grp"><span class="k">Forecast final</span> ${fc}</span>` +
    `<span class="grp w24"><span class="k">Next 24 h</span> ${w24}</span>`;
}

function renderHeads() {
  $("hd-left-note").textContent =
    show === "all"
      ? `One line per event, coloured by current tier · all ${n(events.length)} events`
      : `A mixed sample, coloured by current tier: the ${SAMPLE[2]} most urgent Critical, ${SAMPLE[1]} Elevated, ${SAMPLE[0]} below threshold${anyForecast ? ", plus every escalation" : ""}`;
  const note = $("hd-right-note");
  note.textContent = anyForecast
    ? "One mark per event, in the zone of its forecast final tier"
    : "Forecast arrives with the final-tier forecaster; showing the current tier";
  note.classList.toggle("pending", !anyForecast);
}

function placeHeads() {
  const xd = X(DECISION), chip = $("hd-chip");
  chip.style.left = `${xd}px`;
  const half = chip.offsetWidth / 2 + 12;
  const left = $("hd-left"), right = $("hd-right");
  left.style.right = `${w - xd + half}px`;
  left.style.maxWidth = `${Math.max(120, xd - half - M.l)}px`;
  right.style.left = `${xd + half}px`;
  right.style.right = "8px";
}

// ---------- layout + drawing ----------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  w = wrap.clientWidth;
  h = wrap.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutMarks();
  placeHeads();
  dirty = true;
}

// A unit chart per zone: equal-size marks in rows of equal length from the zone's top edge, so block height compares
// counts. Escalations come first on wider spacing so each one's ring and arrow stay legible.
// Position inside a zone carries no distance or time; only the zone (the tier) is data.
const ESC_W = 14, ESC_H = 11;
function layoutMarks() {
  const xa = X(DECISION) + 12, xb = X(0) - 4;
  const W = Math.max(1, xb - xa);
  const order = (a, b) => ((forecast(b).p ?? -1) - (forecast(a).p ?? -1)) || (rank.get(a.event_id) - rank.get(b.event_id));
  const escCols = Math.max(1, Math.floor(W / ESC_W));
  const groups = ZONES.map((z) => {
    const list = events.filter((e) => forecast(e).tier === z.tier).sort(order);
    const esc = list.filter(escalates), rest = list.filter((e) => !escalates(e));
    const escH = esc.length ? Math.ceil(esc.length / escCols) * ESC_H + 4 : 0;
    return { z, esc, rest, escH, ya: Y(z.hi) + 6, H: Math.max(1, Y(z.lo) - 6 - (Y(z.hi) + 6)), n: list.length };
  });
  // one pitch for every zone, so a mark means one event everywhere
  pitch = 14;
  const fits = (p) => groups.every((g) => g.escH + Math.ceil(g.rest.length / Math.floor(W / p)) * p <= g.H);
  while (pitch > 3 && !fits(pitch)) pitch--;
  const cols = Math.max(1, Math.floor(W / pitch));
  marks.clear();
  for (const g of groups) {
    g.esc.forEach((e, i) => {
      marks.set(e.event_id, { x: xa + ESC_W / 2 - 2 + (i % escCols) * ESC_W, y: g.ya + ESC_H / 2 + Math.floor(i / escCols) * ESC_H });
    });
    g.rest.forEach((e, i) => {
      marks.set(e.event_id, { x: xa + pitch / 2 + (i % cols) * pitch, y: g.ya + g.escH + pitch / 2 + Math.floor(i / cols) * pitch });
    });
    g.z.count = g.n;
  }
}

function loop() {
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(loop);
}

function draw() {
  ctx.clearRect(0, 0, w, h);
  if (!w || !h) return;
  const x0 = M.l, x1 = X(0), yT = M.t, yB = h - M.b, xd = X(DECISION);
  ctx.font = MONO;
  ctx.lineWidth = 1;

  // y grid at decades, labelled in the left margin; thresholds in tier colour
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const km of [0.01, 0.1, 10, 100]) {
    const y = Math.round(Y(km)) + 0.5;
    ctx.strokeStyle = C.hair;
    line(x0, y, x1, y);
    ctx.fillStyle = C.muted;
    ctx.fillText(km >= 1 ? `${km} km` : `${km * 1000} m`, x0 - 10, y);
  }
  // x grid at whole days
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let d = 0; d <= X_MAX; d++) {
    const x = Math.round(X(d)) + 0.5;
    if (d !== DECISION) {
      ctx.strokeStyle = C.hair;
      line(x, yT, x, yB);
    }
    ctx.fillStyle = d === DECISION ? C.ink : C.muted;
    ctx.fillText(d === 0 ? "TCA" : `${d} d`, x, yB + 8);
  }
  ctx.fillStyle = C.muted;
  ctx.textAlign = "left";
  ctx.fillText("TIME TO CLOSEST APPROACH  →", x0, yB + 24);
  ctx.save();
  ctx.translate(16, (yT + yB) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("MISS DISTANCE (LOG)", 0, 0);
  ctx.restore();

  // threshold hairlines, labelled in the left margin
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const [km, tier] of [[1, 2], [5, 1]]) {
    const y = Math.round(Y(km)) + 0.5;
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = TIERS[tier].color;
    line(x0, y, x1, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = TIERS[tier].color;
    ctx.fillText(`${km} km`, x0 - 10, y);
  }

  // zone names + counts in the right margin
  ctx.textAlign = "left";
  for (const z of ZONES) {
    const top = Y(z.hi) + 6;
    ctx.textBaseline = "top";
    ctx.font = MONO;
    ctx.fillStyle = TIERS[z.tier].color;
    z.label.forEach((s, i) => ctx.fillText(s, x1 + 14, top + i * 14));
    ctx.font = MONO_B;
    ctx.fillStyle = C.ink;
    ctx.fillText(n(z.count ?? 0), x1 + 14, top + z.label.length * 14 + 3);
  }
  ctx.font = MONO;

  // the decision line
  ctx.strokeStyle = C.ink;
  ctx.globalAlpha = 0.75;
  ctx.setLineDash([5, 4]);
  line(Math.round(xd) + 0.5, 22, Math.round(xd) + 0.5, yB);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  drawTracks();
  drawMarks();
  drawFocus();
}

function line(ax, ay, bx, by) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

function trackAlpha(tier) {
  if (show !== "all") return 0.35; // the sample; the hovered or selected track is redrawn at full opacity
  return tier === 2 ? 0.5 : tier === 1 ? 0.35 : 0.16;
}

function drawTracks() {
  const list = shownEvents();
  const dim = selected != null ? 0.3 : 1;
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  for (let tier = 0; tier <= 2; tier++) {
    ctx.strokeStyle = ctx.fillStyle = TIERS[tier].color;
    ctx.globalAlpha = trackAlpha(tier) * dim;
    for (const e of list) {
      if (e.tier !== tier) continue;
      const pts = hist.get(e.event_id);
      if (!pts || !pts.length) continue;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.km)) : ctx.moveTo(X(p.t), Y(p.km))));
      ctx.stroke();
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(X(last.t), Y(last.km), 1.6, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawMarks() {
  const r = Math.max(1.4, pitch * 0.32);
  const dim = selected != null ? 0.45 : 1;
  for (let tier = 0; tier <= 2; tier++) {
    ctx.fillStyle = TIERS[tier].color;
    ctx.globalAlpha = (tier === 0 ? 0.6 : 0.92) * dim;
    ctx.beginPath();
    for (const e of events) {
      if (forecast(e).tier !== tier) continue;
      const m = marks.get(e.event_id);
      ctx.moveTo(m.x + r, m.y);
      ctx.arc(m.x, m.y, r, 0, 6.2832);
    }
    ctx.fill();
  }
  // escalations: a ring and a small arrow pointing into the forecast zone (down = closer, worse)
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ctx.fillStyle = C.ink;
  ctx.lineWidth = 1.25;
  for (const e of events) {
    if (!escalates(e)) continue;
    const m = marks.get(e.event_id);
    ctx.beginPath();
    ctx.arc(m.x, m.y, 3.6, 0, 6.2832);
    ctx.stroke();
    const ax = m.x + 7, ay = m.y;
    ctx.beginPath();
    ctx.moveTo(ax, ay - 3.5);
    ctx.lineTo(ax, ay + 3);
    ctx.moveTo(ax - 1.8, ay + 1.2);
    ctx.lineTo(ax, ay + 3);
    ctx.lineTo(ax + 1.8, ay + 1.2);
    ctx.stroke();
  }
}

// hovered / selected event: its whole track, every update, and a dashed link to its forecast mark
function drawFocus() {
  for (const [id, color] of [[hover?.e.event_id, C.ink], [selected, C.own]]) {
    if (id == null) continue;
    const e = byId.get(id), pts = hist.get(id), m = marks.get(id);
    const col = TIERS[e.tier].color;
    if (pts && pts.length) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.km)) : ctx.moveTo(X(p.t), Y(p.km))));
      ctx.stroke();
      ctx.fillStyle = col;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(X(p.t), Y(p.km), 2.6, 0, 6.2832);
        ctx.fill();
      }
      const last = pts[pts.length - 1];
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      line(X(last.t), Y(last.km), m.x, m.y);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(m.x, m.y, Math.max(5, pitch * 0.32 + 4), 0, 6.2832);
    ctx.stroke();
  }
}

// ---------- interaction ----------

function hitTest(mx, my) {
  const rr = Math.max(4, pitch * 0.75) ** 2;
  let best = null, bd = rr;
  for (const e of events) {
    const m = marks.get(e.event_id);
    const d = (m.x - mx) ** 2 + (m.y - my) ** 2;
    if (d < bd) (bd = d), (best = { kind: "mark", e });
  }
  if (best) return best;
  bd = 36; // 6 px from a track
  const list = selected != null && !shownEvents().some((e) => e.event_id === selected) ? [...shownEvents(), byId.get(selected)] : shownEvents();
  for (const e of list) {
    const pts = hist.get(e.event_id);
    if (!pts) continue;
    for (let i = 0; i < pts.length; i++) {
      const ax = X(pts[i].t), ay = Y(pts[i].km);
      const b = pts[i + 1] || pts[i];
      const d = segDist2(mx, my, ax, ay, X(b.t), Y(b.km));
      if (d < bd) (bd = d), (best = { kind: "track", e });
    }
  }
  return best;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

function onMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const hit = hitTest(mx, my);
  if (hit?.e !== hover?.e) (hover = hit), (dirty = true);
  canvas.classList.toggle("hit", !!hit);
  if (!hit) return void (tip.hidden = true);
  const e = hit.e, t = TIERS[e.tier], f = forecast(e);
  let body;
  if (hit.kind === "track") {
    const pts = hist.get(e.event_id), a = pts[0], b = pts[pts.length - 1];
    body = `${n(pts.length)} CDM update${pts.length === 1 ? "" : "s"}, ${fmtDays(a.t)} → ${fmtDays(b.t)}<br>miss ${fmtDist(a.km * 1000)} → ${fmtDist(b.km * 1000)}`;
  } else {
    const ft = TIERS[f.tier];
    body = f.real
      ? `Forecast final: <b style="color:${ft.color}">${ft.name}</b>${f.p != null ? ` · score ${f.p.toFixed(2)}` : ""}${escalates(e) ? " · escalation" : ""}`
      : `<span style="color:${C.muted}">Forecast pending: placed by current tier</span>`;
  }
  tip.innerHTML = `<b style="color:${t.color}">${t.icon} ${t.name}</b> now · EVT ${esc(e.event_id)}<br>${body}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(mx + 14, w - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.max(4, my - 10 - tip.offsetHeight)}px`;
}

function onKey(ev) {
  if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
  ev.preventDefault();
  const i = selected == null ? -1 : rank.get(selected);
  const next = clamp(i + (ev.key === "ArrowRight" ? 1 : -1), 0, events.length - 1);
  select(events[next].event_id, false);
}

async function select(id, focusCard = true) {
  selected = id;
  dirty = true;
  history.replaceState(null, "", id == null ? location.pathname : `#event=${id}`);
  main.classList.toggle("has-card", id != null);
  card.hidden = id == null;
  if (id == null) return canvas.focus({ preventScroll: true });
  renderCard(byId.get(id), null);
  if (focusCard) card.focus({ preventScroll: true });
  try {
    const pts = await loadOne(id);
    if (selected === id) renderCard(byId.get(id), pts);
  } catch {
    if (selected === id) renderCard(byId.get(id), []);
  }
  dirty = true;
}

// ---------- side card ----------

function ruleText(e) {
  const rule = e.tier === 2 && e.action?.reasons?.length ? e.action.reasons[0] : (e.reasons || []).join(" · ");
  const demoted = e.baseline_tier > e.tier ? ` · the model lowered it from ${TIERS[e.baseline_tier].name} (rule)` : "";
  return rule + demoted;
}

const rtnOf = (u) =>
  Array.isArray(u.relative_position_rtn_m) ? u.relative_position_rtn_m
    : ["relative_position_r", "relative_position_t", "relative_position_n"].every((k) => Number.isFinite(u[k]))
      ? [u.relative_position_r, u.relative_position_t, u.relative_position_n] : null;

function rtnSection(e, pts) {
  if (pts == null) return `<p class="dp-missing">Loading CDM updates&hellip;</p>`;
  const rows = pts.map((p) => ({ t: p.t, v: rtnOf(p.u) })).filter((r) => r.v);
  const L = e.latest.relative_position_rtn_m;
  const latest = Array.isArray(L) ? ` Latest update only: R ${fmtDist(L[0])} · T ${fmtDist(L[1])} · N ${fmtDist(L[2])}.` : "";
  if (!rows.length) {
    return `<p class="dp-missing">Missing field: <code>history[]</code> has no <code>relative_position_r/t/n</code> per update, so there is nothing to plot over time.${latest.replaceAll("-", "−")}</p>`;
  }
  if (rows.length === 1) return `<p class="dp-missing">One CDM update only, so no line to draw.${latest.replaceAll("-", "−")}</p>`;
  const W = 288, H = 110, pad = { l: 4, r: 24, t: 14, b: 26 };
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const vmax = Math.max(1, ...rows.flatMap((r) => r.v.map(Math.abs)));
  const sx = (t) => pad.l + (t0 === t1 ? 0.5 : (t0 - t) / (t0 - t1)) * (W - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (v + vmax) / (2 * vmax)) * (H - pad.t - pad.b);
  const SER = [["R", C.ink], ["T", C.own], ["N", C.muted]];
  // end labels, pushed apart so close lines keep readable names
  const last = rows[rows.length - 1];
  const ly = SER.map((_, k) => ({ k, y: sy(last.v[k]) + 3 })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ly.length; i++) ly[i].y = Math.max(ly[i].y, ly[i - 1].y + 10);
  const labelY = Object.fromEntries(ly.map((o) => [o.k, o.y]));
  const series = SER.map(([name, col], k) => {
    const d = rows.map((r, i) => `${i ? "L" : "M"}${sx(r.t).toFixed(1)},${sy(r.v[k]).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.25"/><text x="${W - pad.r + 4}" y="${labelY[k]}" fill="${col}">${name}</text>`;
  });
  return `<svg class="dp-rtn" viewBox="0 0 ${W} ${H}" role="img" aria-label="R, T and N relative position against time to TCA" font-family="Spline Sans Mono, monospace" font-size="10">` +
    `<line x1="${pad.l}" x2="${W - pad.r}" y1="${sy(0)}" y2="${sy(0)}" stroke="${C.hair2}"/>${series.join("")}` +
    `<text x="${pad.l}" y="${pad.t - 5}" fill="${C.muted}">+${fmtDist(vmax)}</text>` +
    `<text x="${pad.l}" y="${H - pad.b + 11}" fill="${C.muted}">−${fmtDist(vmax)}</text>` +
    `<text x="${pad.l}" y="${H - 2}" fill="${C.muted}">${fmtDays(t0)}</text><text x="${W - pad.r}" y="${H - 2}" fill="${C.muted}" text-anchor="end">${fmtDays(t1)}</text></svg>`;
}

function renderCard(e, pts) {
  const t = TIERS[e.tier], f = forecast(e), ft = TIERS[f.tier], L = e.latest;
  const fc = f.real
    ? `<span class="tier" style="color:${ft.color}">${ft.icon} ${ft.name}</span>` +
      `<span class="sub">${f.p != null ? `model score ${f.p.toFixed(2)} (not a calibrated probability)` : "no model score"}${escalates(e) ? ` · <span class="esc">escalation from ${t.name}</span>` : ""}</span>`
    : `<span class="sub">Forecast arrives with the final-tier forecaster; showing the current tier.</span>`;
  card.innerHTML =
    `<div class="dp-card-head"><h2>EVT ${esc(e.event_id)}</h2><button type="button" class="dp-x" aria-label="Close">×</button></div>` +
    `<dl>` +
    `<dt>Now</dt><dd><span class="tier" style="color:${t.color}">${t.icon} ${t.name}</span><span class="sub">${esc(ruleText(e))}</span></dd>` +
    `<dt>Forecast final tier</dt><dd>${fc}</dd>` +
    `<dt>Latest update</dt><dd class="num">${fmtDays(L.time_to_tca_days)} to TCA · ${fmtDist(L.miss_distance_m)} · Pc ≤ ${fmtPc(L.max_risk_estimate_log10)}</dd>` +
    `<dt>R / T / N vs time to TCA</dt><dd>${rtnSection(e, pts)}</dd>` +
    `</dl>` +
    `<a class="dp-open" href="/static/review.html#event=${encodeURIComponent(e.event_id)}">Open decision record →</a>`;
  card.querySelector(".dp-x").addEventListener("click", () => select(null));
}
