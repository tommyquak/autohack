// The side box: one Critical encounter, to scale, and how the pipeline detected it, step by step.
// Every figure is read from /api/events/{id} and /api/summary (docs/CONTRACT.md); nothing is recomputed except
// which of the CDM's own reasons crossed the Critical line, and units.
import { api } from "./api.js";
import { CAUTIONS, TIERS, clamp, esc, fmtDist, fmtPc } from "./fmt.js";

const PLOTLY = ["/static/vendor/plotly-3.1.0.min.js", "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/3.1.0/plotly.min.js"];
const PC_CRIT = -4, PC_ELEV = -6, MISS_CRIT = 1000, MISS_ELEV = 5000;
const CAUTION_WHY = {
  no_covariance: "A position sigma is the dataset's 63,781 km placeholder, so the Pc cannot be trusted on its own.",
  pc_diluted: "The combined radial uncertainty is larger than miss/√2 while Pc < 1e-4: a low Pc may reflect poor tracking, not separation.",
  needs_review: "Close to a threshold or missing input. Uncertainty only ever escalates the tier.",
};
const MK = ["below", "elev", "crit"];
const mark = (tier, extra = "") => `<span class="mk ${MK[tier]} ${extra}" aria-hidden="true"></span>`;
const warnIcon = `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2L11 10.5H1z" fill="none" stroke="#e8a33c" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 4.6v2.9M6 8.6v.1" stroke="#e8a33c" stroke-width="1.2" stroke-linecap="round"/></svg>`;

let lib = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, onload: resolve });
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}
function loadLib() {
  lib ||= (window.Plotly ? Promise.resolve() : loadScript(PLOTLY[0]).catch(() => loadScript(PLOTLY[1])))
    .then(() => (window.CloseApproach ? null : loadScript("/static/close_approach.js")))
    .then(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      window.CloseApproach.theme({
        below: TIERS[0].color, warning: TIERS[1].color, critical: TIERS[2].color,
        text: v("--ink", "#e6ebe8"), muted: v("--muted", "#7d8a85"), grid: v("--hair2", "#2a3532"), surface: v("--panel", "#0b0e0f"),
      });
      return window.CloseApproach;
    })
    .catch((err) => ((lib = null), Promise.reject(err)));
  return lib;
}

const $ = (id) => document.getElementById(id);
const box = $("alert");
let token = 0;
let current = null; // event (list shape) shown in the box
let handlers = {};

export function initAlert(h) {
  handlers = h;
  $("a-close").addEventListener("click", () => handlers.onDismiss());
  $("a-dismiss").addEventListener("click", () => handlers.onDismiss());
  $("a-ack").addEventListener("click", () => handlers.onAck());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !box.hidden) handlers.onDismiss();
  });
}

export const boxWidth = () => box.getBoundingClientRect().width || box.offsetWidth;

// Log-scale gauge: hairline track, threshold ticks, one marker. Danger always lies to the right.
function gauge({ lo, hi, value, reverse = false, ticks, endLabels, color }) {
  const W = 260, y = 18;
  const x = (v) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return (reverse ? 1 - t : t) * W; };
  const tk = ticks.map(([v, label, col]) =>
    `<line x1="${x(v)}" x2="${x(v)}" y1="${y - 7}" y2="${y + 7}" stroke="${col}" stroke-width="1"/>` +
    `<text x="${x(v)}" y="${y - 10}" fill="${col}" font-size="10.5" text-anchor="middle">${label}</text>`).join("");
  const mx = x(value);
  return `<svg class="gauge" viewBox="0 0 ${W} 34" aria-hidden="true" font-family="Spline Sans Mono, monospace">
    <line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#2a3532" stroke-width="1"/>
    ${tk}
    <path d="M${mx} ${y - 1} l-5 -8 h10 z" fill="${color}"/><line x1="${mx}" x2="${mx}" y1="${y}" y2="${y + 8}" stroke="${color}" stroke-width="2"/>
    <text x="0" y="${y + 14}" fill="#7d8a85" font-size="10">${endLabels[0]}</text>
    <text x="${W}" y="${y + 14}" fill="#7d8a85" font-size="10" text-anchor="end">${endLabels[1]}</text>
  </svg>`;
}

const sup = (s) => esc(s).replace(/10\^(-?\d+(?:\.\d+)?)/g, "10<sup>$1</sup>").replace(/&gt;=/g, "≥");
const firesCritical = (r) => />= ?1e-4/.test(r) || /< ?1 km/.test(r);
const objectPhrase = (type) => {
  const t = String(type || "UNKNOWN").toLowerCase();
  if (t === "unknown") return "An unidentified object";
  if (t === "tba") return "An object (type not yet assigned)";
  return `${/^[aeiou]/.test(t) ? "An" : "A"} ${esc(t)}`;
};

function steps(e, summary) {
  const L = e.latest, pc = L.max_risk_estimate_log10, miss = L.miss_distance_m;
  const out = [];
  // 1. The rule that fired
  const fired = e.tier === 2 ? e.reasons.filter(firesCritical) : e.reasons;
  const ctx = e.reasons.filter((r) => !fired.includes(r));
  out.push(["The rule that fired",
    `${fired.map((r) => `<div class="fired mono">${sup(r)}</div>`).join("") || '<div class="mono">no rule text on this CDM</div>'}` +
    (ctx.length ? `<div class="ctx">Also on the latest CDM: <span class="mono">${ctx.map(sup).join(" · ")}</span></div>` : "")]);
  // 2. Pc upper bound against 1e-6 / 1e-4
  const pcCol = pc >= PC_CRIT ? "#ff4a3d" : pc >= PC_ELEV ? "#e8a33c" : "#8a9490";
  const pcWord = pc >= PC_CRIT ? "at or above the 1e-4 line" : pc >= PC_ELEV ? "between 1e-6 and the 1e-4 line" : "below both Pc lines";
  out.push(["Pc upper bound",
    `<span class="mono">≤ ${fmtPc(pc)}</span>, ${pcWord}.` +
    gauge({ lo: -10, hi: -2, value: pc, ticks: [[PC_ELEV, "1e-6", "#e8a33c"], [PC_CRIT, "1e-4", "#ff4a3d"]], endLabels: ["1e-10", "1e-2"], color: pcCol }), "half"]);
  // 3. Miss distance against 1 km / 5 km
  const lg = (m) => Math.log10(Math.max(m, 1));
  const mCol = miss < MISS_CRIT ? "#ff4a3d" : miss <= MISS_ELEV ? "#e8a33c" : "#8a9490";
  const mWord = miss < MISS_CRIT ? "inside the 1 km line" : miss <= MISS_ELEV ? "inside the 5 km line" : "outside both lines";
  const h = e.history || [];
  const trend = h.length > 1
    ? `<div class="ctx">${h.length} CDMs: <span class="mono">${fmtDist(h[0].miss_distance_m)} → ${fmtDist(h[h.length - 1].miss_distance_m)}</span></div>` : "";
  out.push(["Miss distance",
    `<span class="mono">${fmtDist(miss)}</span>, ${mWord}.` +
    gauge({ lo: lg(10), hi: lg(50_000), value: lg(miss), reverse: true, ticks: [[lg(MISS_ELEV), "5 km", "#e8a33c"], [lg(MISS_CRIT), "1 km", "#ff4a3d"]], endLabels: ["50 km", "10 m"], color: mCol }) + trend, "half"]);
  // 4. The model's decision
  const tg = (t) => `<span class="tg">${mark(t)}${TIERS[t].name}</span>`;
  const moved = e.baseline_tier !== e.tier;
  out.push(["The model's decision",
    `<div class="flow"><span class="arrow">rule</span>${tg(e.baseline_tier)}<span class="arrow">→ model</span>${tg(e.tier)}</div>` +
    `<div class="ctx">${moved
      ? `The model moved this from ${TIERS[e.baseline_tier].name} to ${TIERS[e.tier].name}. It only ever demotes, and never touches Critical.`
      : e.tier === 2
        ? "The model never touches Critical. It only re-checks Elevated, and can only demote."
        : "The model kept the rule's tier."}</div>`]);
  // 5. Cautions
  const cs = e.cautions || [];
  out.push(["Cautions on the latest CDM", cs.length
    ? `<div class="badges">${cs.map((c) => `<span class="badge">${warnIcon}${esc(CAUTIONS[c] || c)}</span>`).join("")}</div>` +
      cs.map((c) => (CAUTION_WHY[c] ? `<div class="ctx">${CAUTION_WHY[c]}</div>` : "")).join("")
    : '<span class="muted">None. Position uncertainty is usable and nothing is near a threshold.</span>']);
  // 6. Distance-only or Pc-backed: the headline insight
  const backed = pc >= PC_CRIT;
  let verdict, why, cls;
  if (e.tier < 2) {
    verdict = `${TIERS[e.tier].name}, not Critical`; cls = "dist";
    why = "Neither the 1 km miss line nor the 1e-4 Pc line is crossed.";
  } else if (backed) {
    verdict = "Pc-backed"; cls = "pc";
    why = `Pc bound <span class="mono">${fmtPc(pc)}</span> ≥ 1e-4: the probability backs this alert${miss < MISS_CRIT ? ", and so does the miss under 1 km" : ", even though the miss is outside 1 km"}.`;
  } else {
    verdict = "Critical by distance only"; cls = "dist";
    why = `Pc bound <span class="mono">${fmtPc(pc)}</span> is below 1e-4; the probability doesn't back this manoeuvre.`;
  }
  const d = summary?.critical_drivers;
  const mine = e.tier === 2 ? (miss < MISS_CRIT && backed ? "both" : miss < MISS_CRIT ? "miss_only" : "pc_only") : null;
  const drivers = d
    ? `<div class="drivers"><span>All ${(d.miss_only + d.pc_only + d.both).toLocaleString("en")} Criticals:</span>` +
      [["miss_only", "distance only"], ["pc_only", "Pc only"], ["both", "both"]]
        .map(([k, label]) => `<span class="${k === mine ? "me" : ""}"><b>${d[k]}</b> ${label}</span>`).join("") + "</div>"
    : "";
  out.push(["Distance or probability?", `<span class="verdict">${verdict}</span><div class="why">${why}</div>${drivers}`, `key ${cls}`]);
  // 7. The analyst decides
  out.push(["Analyst decides", `Plan a manoeuvre? <span class="ctx">Second Look never recommends one; the decision stays with you.</span>`, "decide"]);
  return out.map(([k, v, cls = ""], i) =>
    `<li class="step ${cls}" style="--i:${i}"><span class="n">${i + 1}</span><div><div class="k">${k}</div><div class="v">${v}</div></div></li>`).join("");
}

function readings(e, rem) {
  const L = e.latest;
  const rd = (k, v, cls = "", sub = "") => `<div class="rd"><span>${k}</span><b class="${cls}">${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  return rd("Miss", fmtDist(L.miss_distance_m), L.miss_distance_m < MISS_CRIT ? "crit" : "") +
    rd("Pc bound", `≤ ${fmtPc(L.max_risk_estimate_log10)}`, L.max_risk_estimate_log10 >= PC_CRIT ? "crit" : "") +
    rd("Closing", `${(L.relative_speed_ms / 1000).toFixed(1)} km/s`) +
    rd("TCA in (replay)", `<i id="a-rem">${Math.max(0, rem).toFixed(2)}</i> d`, "", `${L.time_to_tca_days.toFixed(2)} d at the snapshot`);
}

export async function showAlert(e, { remaining, summary, pendingCount = 0 }) {
  const mine = ++token;
  current = e;
  const L = e.latest, rem = remaining(e);
  $("a-title").innerHTML = `${mark(e.tier)}${e.tier === 2 ? "Critical encounter" : `${TIERS[e.tier].name} encounter`} <span class="id">#${esc(e.event_id)}</span>`;
  $("a-sentence").innerHTML = `${objectPhrase(L.object_type)} passes <b>${fmtDist(L.miss_distance_m)}</b> from our satellite at closest approach.`;
  $("a-readings").innerHTML = readings(e, rem);
  $("a-next").textContent = pendingCount ? `${pendingCount} more Critical waiting` : "";
  $("steps").innerHTML = "";
  const host = $("a-plot");
  host.innerHTML = '<div class="plot-wait">Loading the close-up&hellip;</div>';
  box.classList.remove("building");
  box.hidden = false;
  box.scrollTop = 0;
  requestAnimationFrame(() => $("a-title").focus({ preventScroll: true }));
  $("announce").textContent = `${TIERS[e.tier].name} encounter, event ${e.event_id}: ${fmtDist(L.miss_distance_m)} miss.`;

  let detail = e;
  try {
    detail = await api.event(e.event_id);
  } catch {
    /* the list copy has everything but the CDM history */
  }
  if (mine !== token) return;
  void box.offsetWidth; // restart the staggered build
  box.classList.add("building");
  $("steps").innerHTML = steps(detail, summary);

  try {
    const CA = await loadLib();
    if (mine !== token) return;
    await CA.render3d(host, detail);
    const plot = host.querySelector(".ca-plot");
    const h = host.clientHeight || 220;
    if (plot && mine === token) {
      await window.Plotly.relayout(plot, { height: h, "scene.camera.eye": { x: 1.3, y: 1.3, z: 0.75 }, "scene.xaxis.title.text": "R", "scene.yaxis.title.text": "T", "scene.zaxis.title.text": "N" });
    }
  } catch (err) {
    if (mine === token) host.innerHTML = `<div class="plot-wait">Close-up unavailable (${esc(err.message)}). The steps below are unaffected.</div>`;
  }
}

export function updateRemaining(rem) {
  if (box.hidden || !current) return;
  const v = Math.max(0, rem).toFixed(2);
  const a = $("a-rem");
  if (a) a.textContent = v;
}

export function hideAlert() {
  token++;
  current = null;
  box.hidden = true;
  box.classList.remove("building");
}
export const shown = () => current;
