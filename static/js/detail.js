// Right rail, section 03: everything the pipeline says about one event, plus a plain-English explanation.
import { api } from "./api.js";
import { CAUTIONS, SIGMA_SENTINEL_M, TIERS, clamp, esc, fmtDays, fmtDist, fmtPc, pct } from "./fmt.js";
import { remaining, state, subscribe } from "./state.js";

const el = document.getElementById("detail");
let token = 0;

export function initDetail() {
  subscribe(["selectedId"], show);
  subscribe(["elapsed"], () => {
    const t = document.getElementById("d-tca");
    const e = state.events.find((x) => x.event_id === state.selectedId);
    if (t && e) t.textContent = remaining(e) > 0 ? fmtDays(remaining(e)) : "passed";
  });
  el.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-llm]")) explain(true);
  });
}

async function show() {
  const id = state.selectedId;
  const mine = ++token;
  if (id === null) return;
  el.setAttribute("aria-busy", "true");
  try {
    const e = await api.event(id);
    if (mine !== token) return;
    el.innerHTML = render(e);
    el.removeAttribute("aria-busy");
    explain(false);
  } catch (err) {
    if (mine === token) el.innerHTML = `<p class="muted">Could not load event ${esc(id)}: ${esc(err.message)}</p>`;
  }
}

async function explain(llm) {
  const id = state.selectedId, mine = token;
  const box = document.getElementById("d-explain");
  if (!box) return;
  if (llm) box.querySelector("p").textContent = "Asking Claude…";
  try {
    const r = await api.explain(id, llm);
    if (mine !== token) return;
    box.innerHTML = `<p>${esc(r.text)}</p><div class="src">${r.source === "claude" ? "Written by Claude from the fields above" : "Template summary of the fields above"}</div>` +
      (r.source === "template" ? `<button type="button" data-llm>Rewrite with Claude</button>` : "");
  } catch (err) {
    if (mine === token) box.innerHTML = `<p class="muted">Explanation unavailable: ${esc(err.message)}</p>`;
  }
}

// log-scale gauge with threshold ticks: marker + bands, as SVG
function gauge({ label, valueText, lo, hi, value, ticks, bands }) {
  const W = 280, pos = (v) => ((clamp(v, lo, hi) - lo) / (hi - lo)) * W;
  const bandSvg = bands.map(([a, b, c]) => `<rect x="${pos(a)}" y="9" width="${Math.max(0, pos(b) - pos(a))}" height="6" fill="${c}" opacity=".28"/>`).join("");
  const tickSvg = ticks.map(([v, t]) => `<line x1="${pos(v)}" x2="${pos(v)}" y1="6" y2="18" stroke="#7d8a85"/><text x="${pos(v)}" y="30" fill="#7d8a85" font-size="9" text-anchor="middle" font-family="Spline Sans Mono, monospace">${t}</text>`).join("");
  const x = pos(value);
  return `<div class="gauge"><div class="cap"><span>${label}</span><span style="color:var(--ink)">${valueText}</span></div>
    <svg viewBox="0 0 ${W} 34" role="img" aria-label="${esc(label)} ${esc(valueText)}"><rect x="0" y="11" width="${W}" height="2" fill="#2a3532"/>${bandSvg}${tickSvg}
    <path d="M${x - 5} 2 L${x + 5} 2 L${x} 10 Z" fill="#e6ebe8"/></svg></div>`;
}

function spark(history) {
  const W = 280, H = 84, P = 4;
  const xs = history.map((p) => p.time_to_tca_days), ys = history.map((p) => p.max_risk_estimate_log10);
  const x0 = Math.max(...xs), x1 = Math.min(...xs, 0);
  const lo = Math.min(-8, ...ys) - 0.3, hi = Math.max(-3.5, ...ys) + 0.3;
  const X = (d) => P + ((x0 - d) / (x0 - x1 || 1)) * (W - 2 * P);
  const Y = (v) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
  const line = history.map((p, i) => `${i ? "L" : "M"}${X(p.time_to_tca_days).toFixed(1)} ${Y(p.max_risk_estimate_log10).toFixed(1)}`).join(" ");
  const dots = history.map((p) => `<circle cx="${X(p.time_to_tca_days).toFixed(1)}" cy="${Y(p.max_risk_estimate_log10).toFixed(1)}" r="3" fill="${TIERS[p.pred_tier].color}" stroke="#080a0b" stroke-width="1.5"><title>${p.time_to_tca_days.toFixed(1)} d to TCA · Pc ≤ ${fmtPc(p.max_risk_estimate_log10)} · ${TIERS[p.pred_tier].name}</title></circle>`).join("");
  const th = (v, c, t) => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="${c}" stroke-dasharray="4 3" opacity=".7"/><text x="${W}" y="${Y(v) - 3}" text-anchor="end" fill="${c}" font-size="9" font-family="Spline Sans Mono, monospace">${t}</text>`;
  return `<div class="spark"><div class="gauge"><div class="cap"><span>Pc upper bound over ${history.length} updates</span></div></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pc upper bound across CDM updates">${th(-4, TIERS[2].color, "1e-4")}${th(-6, TIERS[1].color, "1e-6")}
    <path d="${line}" fill="none" stroke="#7d8a85" stroke-width="1.5"/>${dots}</svg></div>`;
}

function render(e) {
  const L = e.latest, t = TIERS[e.tier], r = remaining(e);
  const demoted = e.baseline_tier > e.tier;
  const sentinel = Math.max(L.sigma_r_m.chaser, L.sigma_r_m.target) > SIGMA_SENTINEL_M;
  const cautions = (e.cautions && e.cautions.length ? e.cautions : e.needs_review ? ["needs_review"] : []);
  return `
    <div class="tier"><span class="tierbadge" style="border-color:${t.color};color:${t.color}">${t.icon} ${t.name}</span><span class="muted num">EVT ${esc(e.event_id)}</span></div>
    <div style="margin-top:12px"><span class="big" style="color:${t.color}">${L.max_risk_estimate_log10.toFixed(2)}</span> <span class="unit">log10 Pc upper bound</span></div>
    ${gauge({ label: "Pc upper bound", valueText: fmtPc(L.max_risk_estimate_log10), lo: -9, hi: -2, value: L.max_risk_estimate_log10, ticks: [[-6, "1e-6"], [-4, "1e-4"]], bands: [[-9, -6, TIERS[0].color], [-6, -4, TIERS[1].color], [-4, -2, TIERS[2].color]] })}
    ${gauge({ label: "Miss distance", valueText: fmtDist(L.miss_distance_m), lo: Math.log10(0.03), hi: Math.log10(100), value: Math.log10(Math.max(L.miss_distance_m / 1000, 0.03)), ticks: [[0, "1 km"], [Math.log10(5), "5 km"]], bands: [[Math.log10(0.03), 0, TIERS[2].color], [0, Math.log10(5), TIERS[1].color], [Math.log10(5), Math.log10(100), TIERS[0].color]] })}
    <dl class="kv">
      <dt>TCA in</dt><dd id="d-tca">${r > 0 ? fmtDays(r) : "passed"}</dd>
      <dt>Closing speed</dt><dd>${(L.relative_speed_ms / 1000).toFixed(1)} km/s</dd>
      <dt>Object</dt><dd>${esc(L.object_type.toLowerCase())}</dd>
      <dt>Confidence</dt><dd>${pct(e.confidence)}</dd>
      <dt>Rule said</dt><dd>${TIERS[e.baseline_tier].name}${demoted ? ` <span class="muted">→ model demoted</span>` : ""}</dd>
      <dt>Radial σ</dt><dd>${sentinel ? "unavailable" : fmtDist(Math.hypot(L.sigma_r_m.chaser, L.sigma_r_m.target))}</dd>
    </dl>
    ${cautions.length ? `<div class="cautions">${cautions.map((c) => `<span class="caution">⚠ ${esc(CAUTIONS[c] || c)}</span>`).join("")}</div>` : ""}
    <ul class="reasons">${(e.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No rule fired.</li>"}</ul>
    ${e.history?.length > 1 ? spark(e.history) : ""}
    <div class="explain" id="d-explain"><p class="muted">Loading explanation…</p></div>`;
}
