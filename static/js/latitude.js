// Right rail, section 05: where encounters happen, by conjunction-point latitude (summary.by_latitude_band).
// Display only: geocentric_latitude is not a model input, and the data has no longitude, so this is a band, not a map point.
import { TIERS, esc } from "./fmt.js";
import { state, subscribe } from "./state.js";

const el = document.getElementById("latitude");
const sum = document.getElementById("lat-sum");

export function initLatitude() {
  subscribe(["summary"], render);
  render();
}

const bandName = ([lo, hi]) => (hi <= 0 ? `${-hi}–${-lo}° S` : lo >= 0 ? `${lo}–${hi}° N` : `${lo}–${hi}°`);

function render() {
  const bands = state.summary?.by_latitude_band;
  if (!el) return;
  if (!bands) {
    el.innerHTML = `<p class="muted">No latitude in this data file.</p>`;
    if (sum) sum.textContent = "no data";
    return;
  }
  const total = bands.reduce((s, b) => s + b.events, 0) || 1;
  const crit = bands.reduce((s, b) => s + b.critical, 0) || 1;
  const hi = bands.filter((b) => b.lat_deg[0] >= 60 || b.lat_deg[1] <= -60);
  const hiEvents = hi.reduce((s, b) => s + b.events, 0), hiCrit = hi.reduce((s, b) => s + b.critical, 0);
  const max = Math.max(...bands.map((b) => b.events), 1);
  if (sum) {
    sum.textContent = `${Math.round((hiEvents / total) * 100)}% >60°`;
    sum.title = `${Math.round((hiEvents / total) * 100)}% of events sit above 60° latitude`;
  }
  const rows = [...bands].reverse().map((b) => {
    const w = (b.events / max) * 100, wc = (b.critical / max) * 100;
    return `<div class="lat-row" title="${esc(bandName(b.lat_deg))}: ${b.events} events, ${b.critical} Critical">
      <span class="lat-name num">${esc(bandName(b.lat_deg))}</span>
      <span class="lat-bar"><i style="width:${w}%"></i><b style="width:${wc}%;background:${TIERS[2].color}"></b></span>
      <span class="lat-n num">${b.events.toLocaleString("en")}</span></div>`;
  }).join("");
  el.innerHTML = `${rows}
    <p class="lat-insight"><b>${Math.round((hiEvents / total) * 100)}%</b> of events and <b>${hiCrit} of ${crit}</b> Critical sit above 60° latitude, where polar and sun-synchronous orbits cross.</p>
    <p class="muted lat-note">Conjunction-point latitude from the CDM, shown for context; not a model input. No longitude in the data.</p>`;
}
