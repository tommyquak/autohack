// Right rail, section 04: what enters the 24-hour window, plus flagged events per half-day across the horizon.
import { MAX_DAYS } from "./fmt.js";
import { remaining, state, subscribe, tierOf, touchFilters, upcoming } from "./state.js";

const SLOTS = MAX_DAYS * 2; // half-day buckets from "now"
const win = document.getElementById("window");
const strip = document.getElementById("strip");
const sum = document.getElementById("window-sum");

export function initStrip() {
  strip.innerHTML =
    Array.from({ length: SLOTS }, (_, i) => `<button type="button" data-slot="${i}" aria-pressed="false"></button>`).join("") +
    `<div class="strip-axis" style="grid-column:1/-1"><span>now</span><span>+${MAX_DAYS / 2} d</span><span>+${MAX_DAYS} d</span></div>`;
  strip.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-slot]");
    if (!b) return;
    const i = Number(b.dataset.slot);
    state.filters.slot = state.filters.slot === i ? null : i;
    touchFilters();
  });
  subscribe(["elapsed", "events", "filters", "horizon"], paint);
  paint();
}

function paint() {
  const up = upcoming();
  // Same definition as triage/build_events.py warnings_24h: TCA inside the window, miss < 1 km, tier Critical
  // (the tier shown: forecast final tier, or the latest message's).
  const inWin = up.filter((e) => remaining(e) <= 1);
  const critIn = inWin.filter((e) => tierOf(e) === 2).length;
  if (sum) sum.textContent = inWin.length ? `${inWin.length} in window · ${critIn} critical` : "none yet";
  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  win.innerHTML =
    stat(inWin.length, "in window") +
    stat(inWin.filter((e) => e.latest.miss_distance_m < 1000).length, "under 1 km") +
    stat(critIn, "critical") +
    (inWin.length === 0
      ? `<p class="window-note">${upcoming().length ? `No event is inside 24 h of closest approach yet; the nearest is ${(Math.min(...up.map(remaining))).toFixed(1)} d out. ` : "Every event has passed closest approach. "}This test set has no CDMs under 2 days to TCA, so press play on the replay clock to watch events arrive.</p>`
      : "");

  const buckets = Array.from({ length: SLOTS }, () => [0, 0]);
  for (const e of up) {
    const t = tierOf(e);
    if (t === 0) continue;
    const i = Math.floor(remaining(e) / 0.5);
    if (i >= 0 && i < SLOTS) buckets[i][t - 1]++;
  }
  const max = Math.max(1, ...buckets.map(([a, b]) => a + b));
  const scale = (n) => (n ? Math.max(4, Math.sqrt(n / max) * 100) : 0); // sqrt keeps the small slots visible
  strip.querySelectorAll("button").forEach((b, i) => {
    const [elev, crit] = buckets[i];
    const total = elev + crit;
    const h = scale(total);
    b.innerHTML = total
      ? `<span class="seg-e" style="height:${total ? (h * elev) / total : 0}%"></span><span class="seg-c" style="height:${total ? (h * crit) / total : 0}%"></span>`
      : "";
    b.setAttribute("aria-pressed", state.filters.slot === i);
    b.title = `${(i * 0.5).toFixed(1)} to ${((i + 1) * 0.5).toFixed(1)} d from now: ${elev} elevated, ${crit} critical`;
    b.setAttribute("aria-label", b.title);
  });
}
