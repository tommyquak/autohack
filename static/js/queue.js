// Left rail: tier/review/type filters, a sort control and the ranked queue (windowed, so 2k rows stay cheap).
import { CAUTIONS, TIERS, esc, fmtDays, fmtDist } from "./fmt.js";
import { remaining, set, state, subscribe, tierOf, touchFilters, visible } from "./state.js";

const ROW = 52;
const SHORT = { needs_review: "review", pc_diluted: "diluted", no_covariance: "no σ" };
const queueEl = document.getElementById("queue");
let list = [];
let spacer;

export function initFilters() {
  const chips = document.getElementById("tier-chips");
  chips.innerHTML = TIERS.map(
    (t, i) => `<button type="button" data-tier="${i}" style="--c:${t.color}" aria-pressed="true"><span style="color:${t.color}">${t.icon}</span> ${t.name}</button>`,
  ).join("");
  chips.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const t = Number(b.dataset.tier);
    const tiers = state.filters.tiers;
    tiers.has(t) ? tiers.delete(t) : tiers.add(t);
    b.setAttribute("aria-pressed", tiers.has(t));
    touchFilters();
  });
  document.getElementById("f-review").addEventListener("change", (ev) => {
    state.filters.review = ev.target.checked;
    touchFilters();
  });
  const sel = document.getElementById("f-type");
  for (const type of [...new Set(state.events.map((e) => e.latest.object_type))].sort()) {
    sel.insertAdjacentHTML("beforeend", `<option value="${esc(type)}">${esc(type.toLowerCase())}</option>`);
  }
  sel.addEventListener("change", () => {
    state.filters.type = sel.value;
    touchFilters();
  });
  const sort = document.getElementById("f-sort");
  sort.addEventListener("change", () => set({ sort: sort.value }));
  document.getElementById("f-clear").addEventListener("click", () => {
    Object.assign(state.filters, { tiers: new Set([0, 1, 2]), review: false, type: "", slot: null, lat: null });
    document.getElementById("f-review").checked = false;
    sel.value = "";
    sort.value = "urgency";
    state.sort = "urgency";
    chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "true"));
    touchFilters();
  });
  subscribe(["filters", "sort"], () => {
    const f = state.filters;
    document.getElementById("f-clear").hidden = f.tiers.size === 3 && !f.review && !f.type && f.slot === null && f.lat === null;
    // The filter panel is folded by default, so its summary says what is on, including filters set from the strip or globe.
    const on = [];
    if (f.tiers.size < 3) on.push(f.tiers.size ? TIERS.filter((_, i) => f.tiers.has(i)).map((t) => t.name).join(" + ") : "no tiers");
    if (f.review) on.push("needs review");
    if (f.type) on.push(f.type.toLowerCase());
    if (f.slot !== null) on.push(`TCA ${(f.slot * 0.5).toFixed(1)}–${((f.slot + 1) * 0.5).toFixed(1)} d`);
    if (f.lat !== null) on.push("one latitude band");
    const sum = document.getElementById("filter-sum");
    if (state.sort !== "urgency") on.push(state.sort === "soonest" ? "soonest first" : "by action queue");
    sum.textContent = on.length ? on.join(" · ") : "All events";
    sum.classList.toggle("on", on.length > 0);
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
  subscribe(["events", "filters", "sort", "horizon"], rebuild);
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
    const e = list[i], t = TIERS[tierOf(e)], L = e.latest;
    const caution = (e.cautions && e.cautions[0]) || (e.needs_review ? "needs_review" : "");
    const flag = caution ? ` <span class="flag" title="${esc(CAUTIONS[caution] || caution)}">⚠ ${esc(SHORT[caution] || caution)}</span>` : "";
    // Forecast differs from the latest message: say so, so an escalation never looks like the current state.
    const now = tierOf(e) !== e.tier ? ` <span class="muted" title="Tier of the latest message">· now ${esc(TIERS[e.tier].name)}</span>` : "";
    rows.push(`<button type="button" class="row" role="option" data-id="${e.event_id}" aria-selected="${e.event_id === state.selectedId}" style="top:${i * ROW}px">
      <span class="ic" style="color:${t.color}" title="${t.name}">${t.icon}</span>
      <span class="id">EVT ${esc(e.event_id)} <span class="muted">${esc(L.object_type.toLowerCase())}</span></span>
      <span class="right">${fmtDays(remaining(e))}</span>
      <span class="meta">${t.name}${now}${flag}</span>
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
