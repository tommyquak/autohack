// Dashboard entry point. Every number on screen comes from /api/* (docs/CONTRACT.md); nothing is typed in by hand.
import { api } from "./api.js";
import { initAsk } from "./ask.js";
import { initClock } from "./clock.js";
import { initDetail } from "./detail.js";
import { initEncounter } from "./encounter.js";
import { initEval } from "./evalview.js";
import { TIERS } from "./fmt.js";
import { initFunnel } from "./funnel.js";
import { initGlobe } from "./globe.js";
import { initLatitude } from "./latitude.js";
import { initFilters, initQueue } from "./queue.js";
import { initRails } from "./rails.js";
import { set, state, subscribe, visible } from "./state.js";
import { initStrip } from "./strip.js";

const banner = document.getElementById("banner");
const fail = (msg) => ((banner.textContent = msg), (banner.hidden = false));

document.getElementById("legend").innerHTML =
  TIERS.map((t) => `<span><b style="color:${t.color}">${t.icon}</b> ${t.name}</span>`).join("") +
  `<span><b style="color:${TIERS[1].color}">◌</b> Ring: needs review</span>`;

// Tier switch: every view reads tiers through tierOf/baseOf (state.js), so one key repaints them all.
function initHorizon(summary, events) {
  const days = events.map((e) => e.latest.time_to_tca_days);
  const hasForecast = events.some((e) => e.forecast);
  const group = document.getElementById("horizon");
  if (!hasForecast) set({ horizon: "now" }); // no forecaster output in this events.json: current tier only
  group.hidden = !hasForecast;
  const stamp = () => {
    const what = state.horizon === "final" ? "forecast final tier on test data" : "per-message predictions on test data";
    document.getElementById("stamp").textContent =
      `${summary.n_events.toLocaleString("en")} events · ${what} · TCA ${Math.min(...days).toFixed(1)}–${Math.max(...days).toFixed(1)} d out`;
  };
  group.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-horizon]");
    if (!b || b.dataset.horizon === state.horizon) return;
    group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    set({ horizon: b.dataset.horizon, filters: state.filters });
  });
  subscribe(["horizon"], stamp);
  stamp();
}

async function main() {
  const [summary, list, metrics] = await Promise.all([api.summary(), api.events(), api.metrics().catch(() => null)]);
  set({ summary, events: list.events, metrics });
  initHorizon(summary, list.events);
  initFilters();
  initQueue();
  initFunnel();
  initDetail();
  initStrip();
  initLatitude();
  initClock();
  initGlobe();
  initEncounter();
  initEval();
  initAsk();
  initRails();
  // The globe is the landing view unless a deep link (/#encounter, /#compare=…) already picked a tab.
  if (!location.hash) document.querySelector('#tabs [data-tab="globe"]')?.click();
  // Open on the most urgent event (in the tier shown) so the right rail isn't empty.
  const top = visible()[0];
  if (top) set({ selectedId: top.event_id });
}

main().catch((err) => {
  document.getElementById("stamp").textContent = "Could not load events";
  fail(err.message);
});
