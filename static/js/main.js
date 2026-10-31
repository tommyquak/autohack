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
import { set, state } from "./state.js";
import { initStrip } from "./strip.js";

const banner = document.getElementById("banner");
const fail = (msg) => ((banner.textContent = msg), (banner.hidden = false));

document.getElementById("legend").innerHTML =
  TIERS.map((t) => `<span><b style="color:${t.color}">${t.icon}</b> ${t.name}</span>`).join("") +
  `<span><b style="color:${TIERS[1].color}">◌</b> Ring: needs review</span>`;

async function main() {
  const [summary, list, metrics] = await Promise.all([api.summary(), api.events(), api.metrics().catch(() => null)]);
  set({ summary, events: list.events, metrics });
  const days = list.events.map((e) => e.latest.time_to_tca_days);
  document.getElementById("stamp").textContent =
    `${summary.n_events.toLocaleString("en")} events · test-set predictions · TCA ${Math.min(...days).toFixed(1)}–${Math.max(...days).toFixed(1)} d out`;
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
  // Open on the most urgent event so the right rail isn't empty.
  if (list.events.length) set({ selectedId: list.events[0].event_id });
}

main().catch((err) => {
  document.getElementById("stamp").textContent = "Could not load events";
  fail(err.message);
});
