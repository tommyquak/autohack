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
export const LAT_BAND = 10; // degrees of latitude per globe band
export const latBand = (deg) => Math.min(180 / LAT_BAND - 1, Math.max(0, Math.floor((deg + 90) / LAT_BAND)));
export const MAX_DAYS = 7; // replay horizon (events are 2.0-6.9 d from TCA)

export const km = (m) => m / 1000;
export const fmtDist = (m) => (m < 10_000 ? `${Math.round(m).toLocaleString("en")} m` : `${(m / 1000).toFixed(1)} km`);
// Pc from its log10, as people write it: -4.38 -> "4.2e-5" (not "1e-4.4").
export const fmtPc = (log10) => {
  if (log10 == null || !Number.isFinite(log10)) return "—";
  let e = Math.floor(log10), m = Math.round(10 ** (log10 - e) * 10) / 10;
  if (m >= 10) { m = 1; e += 1; }
  return `${m.toFixed(1)}e${e}`;
};
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
