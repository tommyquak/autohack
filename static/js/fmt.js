// Shared constants and formatters. Tiers come from the pipeline (docs/CONTRACT.md); nothing here recomputes them.
export const TIERS = [
  { name: "Below threshold", icon: "○", color: "#8a9490" }, // neutral on purpose: never read as "safe"
  { name: "Elevated", icon: "▲", color: "#e8a33c" },
  { name: "Critical", icon: "■", color: "#ff4a3d" },
];
export const CAUTIONS = {
  needs_review: "Needs review",
  pc_diluted: "Pc may be diluted by uncertainty",
  no_covariance: "No usable position uncertainty",
};
export const SIGMA_SENTINEL_M = 1e7; // dataset placeholder for an unusable sigma is ~63,781 km
export const MAX_DAYS = 7; // replay horizon (events are 2.0-6.9 d from TCA)

export const km = (m) => m / 1000;
export const fmtDist = (m) => (m < 10_000 ? `${Math.round(m).toLocaleString("en")} m` : `${(m / 1000).toFixed(1)} km`);
export const fmtPc = (log10) => `1e${log10.toFixed(1)}`;
export const fmtDays = (d) => `${d.toFixed(d < 10 ? 2 : 1)} d`;
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const pct = (v) => `${(v * 100).toFixed(v === 1 || v === 0 ? 0 : 1)}%`;

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}
