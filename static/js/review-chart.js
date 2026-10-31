// Approach history: miss distance at each CDM update, against the 1 km (Critical) and 5 km (Elevated) lines.
// This is the encounter's "trajectory" in the only terms the data supports; there is no orbit or longitude to draw.
import { TIERS, esc, fmtDist, fmtPc } from "./fmt.js";

const axLabel = (m) => (m < 1000 ? `${m} m` : `${m / 1000} km`);
const M = { l: 56, r: 64, t: 14, b: 26 };
const H = 176;

// Shared time axis (whole days, TCA to the right) so the strips below line up with the miss chart.
function days(pts) {
  const ts = pts.map((p) => p.time_to_tca_days);
  let t0 = Math.ceil(Math.max(...ts)), t1 = Math.floor(Math.min(...ts));
  if (t0 - t1 < 1) t0 = t1 + 1;
  return [t0, t1];
}
const timeX = (history, iw) => {
  const [t0, t1] = days((history || []).filter((h) => Number.isFinite(h.time_to_tca_days)));
  return (t) => M.l + ((t0 - t) / (t0 - t1)) * iw;
};

export function approachChart(history, width) {
  const pts = (history || []).filter((h) => h.miss_distance_m > 0 && Number.isFinite(h.time_to_tca_days));
  if (!pts.length) return `<p class="muted small">No CDM updates with a miss distance.</p>`;
  const W = Math.max(280, Math.round(width));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const [t0, t1] = days(pts);
  const logs = pts.map((p) => Math.log10(p.miss_distance_m));
  const y0 = Math.min(Math.log10(400), Math.min(...logs) - 0.15);
  const y1 = Math.max(Math.log10(20_000), Math.max(...logs) + 0.15);
  const x = (t) => M.l + ((t0 - t) / (t0 - t1)) * iw; // time runs left to right, toward TCA
  const y = (m) => M.t + (1 - (Math.log10(m) - y0) / (y1 - y0)) * ih;

  const parts = [];
  // recessive grid: decades, unlabelled where a threshold line already speaks
  for (let d = Math.ceil(y0); d <= Math.floor(y1); d++) {
    const m = 10 ** d, yy = y(m).toFixed(1);
    parts.push(`<line class="grid" x1="${M.l}" x2="${M.l + iw}" y1="${yy}" y2="${yy}"/>`);
    if (m !== 1000) parts.push(`<text class="ax" x="${M.l - 8}" y="${yy}" text-anchor="end" dy=".32em">${axLabel(m)}</text>`);
  }
  for (let t = t0; t >= t1; t--) {
    const xx = x(t).toFixed(1);
    parts.push(`<line class="grid" x1="${xx}" x2="${xx}" y1="${M.t}" y2="${M.t + ih}"/>`);
    parts.push(`<text class="ax" x="${xx}" y="${H - 6}" text-anchor="middle">${t} d</text>`);
  }
  // threshold lines, labelled once at the left in ink, coloured by the tier they guard
  for (const [m, tier, label] of [[1000, 2, "1 km"], [5000, 1, "5 km"]]) {
    if (Math.log10(m) < y0 || Math.log10(m) > y1) continue;
    const yy = y(m).toFixed(1);
    parts.push(`<line class="thr t${tier}" x1="${M.l}" x2="${M.l + iw}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="ax thr-l" x="${M.l - 8}" y="${yy}" text-anchor="end" dy=".32em">${label}</text>`);
  }
  // the approach
  if (pts.length > 1) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.time_to_tca_days).toFixed(1)},${y(p.miss_distance_m).toFixed(1)}`).join("");
    parts.push(`<path class="trace" d="${d}"/>`);
  }
  pts.forEach((p, i) => {
    const tier = TIERS[p.pred_tier] || TIERS[0];
    const tip = `${p.time_to_tca_days.toFixed(2)} d to TCA · ${fmtDist(p.miss_distance_m)} · ${tier.name}`;
    const last = i === pts.length - 1;
    parts.push(
      `<g class="pt"><circle cx="${x(p.time_to_tca_days).toFixed(1)}" cy="${y(p.miss_distance_m).toFixed(1)}" r="${last ? 5.5 : 4}" fill="${tier.color}"/><title>${esc(tip)}</title></g>`,
    );
  });
  const lp = pts[pts.length - 1];
  parts.push(
    `<text class="now" x="${(x(lp.time_to_tca_days) + 10).toFixed(1)}" y="${y(lp.miss_distance_m).toFixed(1)}" dy=".32em">${esc(fmtDist(lp.miss_distance_m))}</text>`,
  );

  const first = pts[0];
  const aria = `Miss distance over ${pts.length} CDM update${pts.length === 1 ? "" : "s"}: ${fmtDist(first.miss_distance_m)} at ${first.time_to_tca_days.toFixed(1)} days to TCA, now ${fmtDist(lp.miss_distance_m)} at ${lp.time_to_tca_days.toFixed(1)} days.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">${parts.join("")}</svg>`;
}

// Thin strip: Pc upper bound per update against the 1e-6 and 1e-4 lines. Grey when the covariance is a placeholder.
export function pcStrip(history, width, unreliable = false) {
  const pts = (history || []).filter((h) => Number.isFinite(h.max_risk_estimate_log10) && Number.isFinite(h.time_to_tca_days));
  if (!pts.length) return "";
  const W = Math.max(280, Math.round(width)), SH = 64, t = 8, b = 8, ih = SH - t - b, iw = W - M.l - M.r;
  const v = pts.map((p) => p.max_risk_estimate_log10);
  const lo = Math.max(-12, Math.min(-7, Math.min(...v) - 0.3)), hi = Math.max(-3, Math.max(...v) + 0.3);
  const x = timeX(pts, iw), y = (v) => t + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ih;
  const parts = [];
  for (const [v, tier, label] of [[-4, 2, "1e-4"], [-6, 1, "1e-6"]]) {
    const yy = y(v).toFixed(1);
    parts.push(`<line class="thr t${tier}" x1="${M.l}" x2="${M.l + iw}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="ax thr-l" x="${M.l - 8}" y="${yy}" text-anchor="end" dy=".32em">${label}</text>`);
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.time_to_tca_days).toFixed(1)},${y(p.max_risk_estimate_log10).toFixed(1)}`).join("");
  parts.push(`<path class="trace pc${unreliable ? " grey" : ""}" d="${d}"/>`);
  pts.forEach((p) => {
    parts.push(`<g class="pt"><circle class="pcdot${unreliable ? " grey" : ""}" cx="${x(p.time_to_tca_days).toFixed(1)}" cy="${y(p.max_risk_estimate_log10).toFixed(1)}" r="2.5"/><title>${p.time_to_tca_days.toFixed(2)} d to TCA · Pc ≤ ${esc(fmtPc(p.max_risk_estimate_log10))}</title></g>`);
  });
  const lp = pts[pts.length - 1];
  parts.push(`<text class="now${unreliable ? " grey" : ""}" x="${(x(lp.time_to_tca_days) + 10).toFixed(1)}" y="${y(lp.max_risk_estimate_log10).toFixed(1)}" dy=".32em">${esc(fmtPc(lp.max_risk_estimate_log10))}</text>`);
  const aria = `Pc upper bound over ${pts.length} updates, now ${fmtPc(lp.max_risk_estimate_log10)}${unreliable ? " (no usable covariance)" : ""}.`;
  return `<svg class="chart strip" viewBox="0 0 ${W} ${SH}" width="${W}" height="${SH}" role="img" aria-label="${esc(aria)}">${parts.join("")}</svg>`;
}

// R/T/N relative position per update (history[].relative_position_rtn_m), three thin lines. "" if the field is absent.
export function rtnChart(history, width) {
  const ok = (h) => Array.isArray(h.relative_position_rtn_m) && h.relative_position_rtn_m.length === 3
    && h.relative_position_rtn_m.every(Number.isFinite) && Number.isFinite(h.time_to_tca_days);
  const pts = (history || []).filter(ok);
  if (pts.length < 2) return "";
  const W = Math.max(280, Math.round(width)), SH = 96, t = 8, b = 8, ih = SH - t - b, iw = W - M.l - M.r;
  const max = Math.max(1, ...pts.flatMap((h) => h.relative_position_rtn_m.map(Math.abs)));
  const x = timeX(pts, iw), y = (v) => t + (1 - (v + max) / (2 * max)) * ih;
  const km = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`);
  const parts = [`<line class="grid" x1="${M.l}" x2="${M.l + iw}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`];
  for (const v of [max, 0, -max]) {
    parts.push(`<text class="ax" x="${M.l - 8}" y="${y(v).toFixed(1)}" text-anchor="end" dy=".32em">${v < 0 ? "\u2212" : ""}${km(Math.abs(v))}</text>`);
  }
  const lp = pts[pts.length - 1];
  // end labels, nudged apart so R, T and N never sit on top of each other
  const ends = [0, 1, 2].map((k) => ({ k, y: y(lp.relative_position_rtn_m[k]) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { if (i) e.y = Math.max(e.y, ends[i - 1].y + 11); });
  "RTN".split("").forEach((axis, k) => {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.time_to_tca_days).toFixed(1)},${y(p.relative_position_rtn_m[k]).toFixed(1)}`).join("");
    const ly = ends.find((e) => e.k === k).y;
    parts.push(`<path class="rtn-l a${k}" d="${d}"><title>${axis}</title></path>`);
    parts.push(`<text class="rtn-k a${k}" x="${(x(lp.time_to_tca_days) + 8).toFixed(1)}" y="${ly.toFixed(1)}" dy=".32em">${axis}</text>`);
  });
  return `<svg class="chart strip" viewBox="0 0 ${W} ${SH}" width="${W}" height="${SH}" role="img" aria-label="Relative position R, T and N over ${pts.length} updates">${parts.join("")}</svg>`;
}
