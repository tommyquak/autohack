// Left rail: the ranked queue and its clear-filters link (windowed, so 2k rows stay cheap).
import { CAUTIONS, TIERS, esc, fmtDays, fmtDist } from "./fmt.js";
import { remaining, set, state, subscribe, touchFilters, visible } from "./state.js";

const ROW = 52;
const SHORT = { needs_review: "review", pc_diluted: "diluted", no_covariance: "no σ" };
const queueEl = document.getElementById("queue");
let list = [];
let spacer;

export function initFilters() {
  // The filter dropdown is gone; the globe band and the 24 h strip still filter, so keep a way to clear them.
  const clear = document.getElementById("f-clear");
  clear.addEventListener("click", () => {
    Object.assign(state.filters, { tiers: new Set([0, 1, 2]), review: false, type: "", slot: null, lat: null });
    touchFilters();
  });
  subscribe(["filters"], () => {
    const f = state.filters;
    clear.hidden = f.tiers.size === 3 && !f.review && !f.type && f.slot === null && f.lat === null;
  });
}

export function initQueue() {
  spacer = document.createElement("div");
  spacer.className = "spacer";
  queueEl.appendChild(spacer);
  queueEl.setAttribute("role", "listbox");
  queueEl.addEventListener("scroll", paint, { passive: true });
  queueEl.addEventListener("click", (ev) => {
    const row = ev.target.closest(".row");
    if (row) set({ selectedId: Number(row.dataset.id) });
  });
  queueEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    if (!list.length) return;
    const i = list.findIndex((e) => e.event_id === state.selectedId);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))];
    set({ selectedId: next.event_id });
  });
  new ResizeObserver(paint).observe(queueEl);
  subscribe(["events", "filters"], rebuild);
  // The replay clock changes TCA text on every frame; repaint at a calmer rate.
  let last = 0;
  subscribe(["elapsed"], () => {
    const now = performance.now();
    if (now - last > 150) {
      last = now;
      rebuild();
    }
  });
  subscribe(["selectedId"], () => {
    paint();
    scrollToSelected();
  });
  rebuild();
}

function rebuild() {
  list = visible();
  spacer.style.height = `${list.length * ROW}px`;
  document.getElementById("queue-count").textContent = `${list.length.toLocaleString("en")} of ${state.events.length.toLocaleString("en")}`;
  paint();
}

function paint() {
  if (!list.length) {
    spacer.innerHTML = `<p class="empty-q">No events match these filters.</p>`;
    return;
  }
  const top = queueEl.scrollTop;
  const first = Math.max(0, Math.floor(top / ROW) - 3);
  const last = Math.min(list.length, Math.ceil((top + queueEl.clientHeight) / ROW) + 3);
  const rows = [];
  for (let i = first; i < last; i++) {
    const e = list[i], t = TIERS[e.tier], L = e.latest;
    const caution = (e.cautions && e.cautions[0]) || (e.needs_review ? "needs_review" : "");
    const flag = caution ? ` <span class="flag" title="${esc(CAUTIONS[caution] || caution)}">⚠ ${esc(SHORT[caution] || caution)}</span>` : "";
    rows.push(`<button type="button" class="row" role="option" data-id="${e.event_id}" aria-selected="${e.event_id === state.selectedId}" style="top:${i * ROW}px">
      <span class="ic" style="color:${t.color}" title="${t.name}">${t.icon}</span>
      <span class="id">EVT ${esc(e.event_id)} <span class="muted">${esc(L.object_type.toLowerCase())}</span></span>
      <span class="right">${fmtDays(remaining(e))}</span>
      <span class="meta">${t.name}${flag}</span>
      <span class="right">${fmtDist(L.miss_distance_m)}</span>
    </button>`);
  }
  spacer.innerHTML = rows.join("");
}

function scrollToSelected() {
  const i = list.findIndex((e) => e.event_id === state.selectedId);
  if (i < 0) return;
  const top = i * ROW, view = queueEl.clientHeight;
  if (top < queueEl.scrollTop || top + ROW > queueEl.scrollTop + view) queueEl.scrollTop = Math.max(0, top - view / 2 + ROW / 2);
}
