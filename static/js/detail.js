// Right rail: everything the pipeline says about one event, plus a plain-English explanation.
// Order is the triage read: tier, the two quantities that set it, why, the prose; the rest folds under "More detail".
import { api } from "./api.js";
import { CAUTIONS, SIGMA_SENTINEL_M, TIERS, clamp, esc, fmtDays, fmtDist, fmtPc, pct } from "./fmt.js";
import { remaining, state, subscribe, tierOf } from "./state.js";

const el = document.getElementById("detail");
let token = 0;
let moreOpen = false; // "More detail" stays open across selections once the analyst opens it

export function initDetail() {
  subscribe(["selectedId", "horizon"], show);
  subscribe(["elapsed"], () => {
    const t = document.getElementById("d-tca");
    const e = state.events.find((x) => x.event_id === state.selectedId);
    if (t && e) t.textContent = remaining(e) > 0 ? fmtDays(remaining(e)) : "passed";
  });
  el.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-llm]")) explain(true);
    const more = ev.target.closest("[data-expand]");
    if (more) {
      const open = more.closest(".explain").classList.toggle("open");
      more.textContent = open ? "Show less" : "Show more";
    }
  });
  el.addEventListener("toggle", (ev) => {
    if (ev.target.id === "d-more") moreOpen = ev.target.open;
  }, true);
}

// Small drawn tile per object type (one stroke weight, no emoji): payload = satellite, debris = shard, rocket body = cylinder.
const GLYPHS = {
  PAYLOAD: '<rect x="9.5" y="9" width="5" height="6" rx="1"/><rect x="2.5" y="10" width="5.5" height="4" rx=".5"/><rect x="16" y="10" width="5.5" height="4" rx=".5"/><path d="M8 12h1.5M14.5 12H16M12 9V6"/>',
  DEBRIS: '<path d="M5 15l4-9 5 3 4 6-5 4z"/><path d="M9 6l2 6 7 3"/>',
  "ROCKET BODY": '<rect x="8" y="3" width="8" height="14" rx="3"/><path d="M10 17l-2 4h8l-2-4M8 9h8"/>',
};
const glyph = (type) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[type] || '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>'}</svg>`;

async function show() {
  const id = state.selectedId;
  const mine = ++token;
  if (id === null) return;
  el.setAttribute("aria-busy", "true");
  try {
    const e = await api.event(id);
    if (mine !== token) return;
    el.innerHTML = render(e);
    el.closest(".sel")?.style.setProperty("--tier", TIERS[tierOf(e)].color); // colours the card's bottom edge
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
    box.classList.remove("open");
    box.innerHTML = `<p class="clamp">${esc(r.text)}</p><button type="button" class="more-text" data-expand>Show more</button><div class="src">${r.source === "claude" ? "Written by Claude from the fields above" : "Template summary of the fields above"}</div>` +
      (r.source === "template" ? `<button type="button" data-llm>Rewrite with Claude</button>` : "");
  } catch (err) {
    if (mine === token) box.innerHTML = `<p class="muted">Explanation unavailable: ${esc(err.message)}</p>`;
  }
}

// log-scale gauge with threshold ticks: marker + bands, as SVG
function gauge({ label, valueText, lo, hi, value, ticks, bands }) {
  const W = 280, pos = (v) => ((clamp(v, lo, hi) - lo) / (hi - lo)) * W;
  const bandSvg = bands.map(([a, b, c]) => `<rect x="${pos(a)}" y="9" width="${Math.max(0, pos(b) - pos(a))}" height="6" fill="${c}" opacity=".28"/>`).join("");
  const tickSvg = ticks.map(([v, t]) => `<line x1="${pos(v)}" x2="${pos(v)}" y1="6" y2="18" stroke="#7d8a85"/><text x="${pos(v)}" y="30" fill="#7d8a85" font-size="10" text-anchor="middle" font-family="Spline Sans Mono, monospace">${t}</text>`).join("");
  const x = pos(value);
  return `<div class="gauge"><div class="cap"><span>${label}</span><b class="num">${valueText}</b></div>
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
  return `<div class="spark"><div class="cap">Pc upper bound over ${history.length} updates</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pc upper bound across CDM updates">${th(-4, TIERS[2].color, "1e-4")}${th(-6, TIERS[1].color, "1e-6")}
    <path d="${line}" fill="none" stroke="#7d8a85" stroke-width="1.5"/>${dots}</svg></div>`;
}

function render(e) {
  const L = e.latest, t = TIERS[tierOf(e)], r = remaining(e);
  const demoted = e.baseline_tier > e.tier;
  // Final-tier view: headline is the forecast; the latest message's tier and the forecast's reasons sit under it.
  const fc = state.horizon === "final" && e.forecast ? e.forecast : null;
  const fcLine = fc
    ? `<p class="hero-rule">Forecast final tier at closest approach${fc.predicted_final_tier > fc.floor_tier ? `, escalated from the rule floor <b style="color:${TIERS[fc.floor_tier].color}">${TIERS[fc.floor_tier].name}</b>` : ""}. Latest message now: <b style="color:${TIERS[e.tier].color}">${TIERS[e.tier].name}</b>.</p>` +
      `<p class="hero-rule muted">${esc(fc.reasons?.[0] || "")}</p>`
    : "";
  const sentinel = Math.max(L.sigma_r_m.chaser, L.sigma_r_m.target) > SIGMA_SENTINEL_M;
  const cautions = (e.cautions && e.cautions.length ? e.cautions : e.needs_review ? ["needs_review"] : []);
  return `
    <div class="hero">
      <div class="dcard-head">
        <span class="otile" style="color:${t.color}" aria-hidden="true">${glyph(L.object_type)}</span>
        <div><div class="dcard-title num">EVT ${esc(e.event_id)}</div>
          <div class="dcard-sub num">${esc(L.object_type.toLowerCase())} · TCA in <span id="d-tca">${r > 0 ? fmtDays(r) : "passed"}</span></div></div>
      </div>
      <div class="tier-name" style="color:${t.color}"><span aria-hidden="true">${t.icon}</span> ${t.name}</div>
      ${fcLine}
      ${demoted && !fc ?`<p class="hero-rule">Rule said <b style="color:${TIERS[e.baseline_tier].color}">${TIERS[e.baseline_tier].name}</b>; the model demoted it.</p>` : ""}
    </div>
    ${gauge({ label: "Pc upper bound", valueText: fmtPc(L.max_risk_estimate_log10), lo: -9, hi: -2, value: L.max_risk_estimate_log10, ticks: [[-6, "1e-6"], [-4, "1e-4"]], bands: [[-9, -6, TIERS[0].color], [-6, -4, TIERS[1].color], [-4, -2, TIERS[2].color]] })}
    ${gauge({ label: "Miss distance", valueText: fmtDist(L.miss_distance_m), lo: Math.log10(0.03), hi: Math.log10(100), value: Math.log10(Math.max(L.miss_distance_m / 1000, 0.03)), ticks: [[0, "1 km"], [Math.log10(5), "5 km"]], bands: [[Math.log10(0.03), 0, TIERS[2].color], [0, Math.log10(5), TIERS[1].color], [Math.log10(5), Math.log10(100), TIERS[0].color]] })}
    <div class="why">
      <h3>Why</h3>
      ${cautions.length ? `<div class="cautions">${cautions.map((c) => `<span class="caution">⚠ ${esc(CAUTIONS[c] || c)}</span>`).join("")}</div>` : ""}
      <ul class="reasons">${(e.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No rule fired.</li>"}</ul>
    </div>
    <div class="explain" id="d-explain"><p class="muted">Loading explanation…</p></div>
    <details class="more" id="d-more"${moreOpen ? " open" : ""}>
      <summary>More detail</summary>
      <dl class="kv">
        <dt>log10 Pc bound</dt><dd>${L.max_risk_estimate_log10.toFixed(2)}</dd>
        <dt>Closing speed</dt><dd>${(L.relative_speed_ms / 1000).toFixed(1)} km/s</dd>
        <dt>Confidence</dt><dd>${pct(e.confidence)}</dd>
        <dt>Rule said</dt><dd>${TIERS[e.baseline_tier].name}${demoted ? ` <span class="muted">→ model demoted</span>` : ""}</dd>
        ${L.geocentric_latitude_deg != null ? `<dt title="Conjunction-point latitude; display only, not a model input">Latitude</dt><dd>${Math.abs(L.geocentric_latitude_deg).toFixed(1)}° ${L.geocentric_latitude_deg >= 0 ? "N" : "S"}</dd>` : ""}
        ${L.target_altitude_km?.[0] != null ? `<dt title="Our satellite's perigee–apogee altitude; display only">Altitude</dt><dd>${Math.round(L.target_altitude_km[0])}–${Math.round(L.target_altitude_km[1])} km</dd>` : ""}
        <dt>Radial σ</dt><dd>${sentinel ? "unavailable" : fmtDist(Math.hypot(L.sigma_r_m.chaser, L.sigma_r_m.target))}</dd>
      </dl>
      ${e.history?.length > 1 ? spark(e.history) : ""}
    </details>`;
}
