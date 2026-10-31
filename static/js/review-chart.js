// Approach history: miss distance at each CDM update, against the 1 km (Critical) and 5 km (Elevated) lines.
// This is the encounter's "trajectory" in the only terms the data supports; there is no orbit or longitude to draw.
import { TIERS, esc, fmtDist } from "./fmt.js";

const axLabel = (m) => (m < 1000 ? `${m} m` : `${m / 1000} km`);
const M = { l: 56, r: 64, t: 14, b: 26 };
const H = 210;

export function approachChart(history, width) {
  const pts = (history || []).filter((h) => h.miss_distance_m > 0 && Number.isFinite(h.time_to_tca_days));
  if (!pts.length) return `<p class="muted small">No CDM updates with a miss distance.</p>`;
  const W = Math.max(280, Math.round(width));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const ts = pts.map((p) => p.time_to_tca_days);
  let t0 = Math.ceil(Math.max(...ts)), t1 = Math.floor(Math.min(...ts));
  if (t0 - t1 < 1) t0 = t1 + 1;
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
