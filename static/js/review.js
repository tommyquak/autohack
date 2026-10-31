// Review page: one status line, three queues on the left, the selected event on the right. Supports #event=<id>.
// The analyst decides; this page only shows the queue, the evidence and the decision record behind each tier.
import { api } from "./api.js";
import { TIERS, esc, fmtDist, fmtDays } from "./fmt.js";
import { renderDetail, drawChart } from "./review-detail.js";

const QUEUES = ["MANEUVER PLANNING", "ANALYST REVIEW", "MONITOR"];
const KEY = "second-look.reviewed.v1";
const TIER_SHORT = ["Below", "Elevated", "Critical"];

const $ = (id) => document.getElementById(id);
const listEl = $("list"), detailEl = $("detail");
let selected = null, current = null, token = 0;

// reviewed ticks live only in this browser; storage can be blocked, so every access is guarded
function loadReviewed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return new Set();
  }
}
const reviewed = loadReviewed();
function saveReviewed() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...reviewed]));
  } catch {
    /* storage unavailable: ticks last for this visit only */
  }
}

const n = (v) => Number(v).toLocaleString("en");

async function audit() {
  try {
    const res = await fetch("/api/audit");
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

function status(summary, events, aud) {
  const flagged = (by) => (by?.Elevated || 0) + (by?.Critical || 0);
  const before = flagged(summary.by_baseline_tier), after = flagged(summary.by_tier);
  const cut = before ? Math.round((1 - after / before) * 100) : 0;
  const w = summary.warnings_24h || {};
  const minTca = Math.min(...events.map((e) => e.latest?.time_to_tca_days ?? Infinity));
  const within = w.within_dangerous_distance ?? 0;
  const why = !w.events_in_window && Number.isFinite(minTca)
    ? `<span class="muted">(no CDM is under ${minTca.toFixed(1)} d to TCA)</span>`
    : `<span class="muted">(of ${n(w.events_in_window || 0)} in window)</span>`;
  let inv = "";
  if (aud) {
    const pass = aud.status === "PASS";
    const ok = (aud.checks || []).filter((c) => c.passed).length;
    inv = `<span class="seg">Safety invariants <b class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</b> <span class="muted num">${ok}/${(aud.checks || []).length}</span></span>`;
  }
  $("status").innerHTML = `
    <span class="seg">To review <b class="num">${n(before)} → ${n(after)}</b> <span class="muted">rule → Second Look, ${cut}% fewer</span></span>
    <span class="seg">Next 24 h <b class="num${within ? " warn" : ""}">${n(within)}</b> within 1 km ${why}</span>
    ${inv}`;
}

function row(e) {
  const done = reviewed.has(e.event_id);
  const t = TIERS[e.tier] || TIERS[0];
  const L = e.latest || {};
  return `<li class="row${done ? " done" : ""}" data-id="${e.event_id}">
    <input type="checkbox" class="tick" data-id="${e.event_id}" ${done ? "checked" : ""} aria-label="Event ${e.event_id} reviewed" title="Reviewed">
    <button type="button" class="pick" data-id="${e.event_id}" aria-label="Event ${e.event_id}, ${esc(t.name)}">
      <span class="id num">${e.event_id}</span>
      <span class="tr t${e.tier}">${TIER_SHORT[e.tier] || t.name}</span>
      <span class="r num">${L.miss_distance_m != null ? esc(fmtDist(L.miss_distance_m)) : "n/a"}</span>
      <span class="r num muted">${L.time_to_tca_days != null ? esc(fmtDays(L.time_to_tca_days)) : "n/a"}</span>
    </button></li>`;
}

function renderList(events) {
  const groups = Object.fromEntries(QUEUES.map((q) => [q, []]));
  for (const e of events) (groups[e.action?.queue] || groups["ANALYST REVIEW"]).push(e);
  listEl.innerHTML = `<div class="cols-h" aria-hidden="true"><span></span><span>Event</span><span>Tier</span><span class="r">Miss</span><span class="r">TCA in</span></div>` +
    QUEUES.map((q) => `<section class="q" aria-label="${q}">
      <h2>${q.toLowerCase()} <span class="count num">${n(groups[q].length)}</span></h2>
      ${groups[q].length ? `<ul>${groups[q].map(row).join("")}</ul>` : `<p class="muted small">Nothing in this queue.</p>`}</section>`).join("");
}

function mark(id) {
  listEl.querySelectorAll('.row[aria-current="true"]').forEach((r) => r.removeAttribute("aria-current"));
  const r = listEl.querySelector(`.row[data-id="${id}"]`);
  if (r) {
    r.setAttribute("aria-current", "true");
    r.scrollIntoView({ block: "nearest" });
  }
}

async function select(id) {
  if (id == null || id === selected) return;
  selected = id;
  mark(id);
  if (location.hash !== `#event=${id}`) history.replaceState(null, "", `#event=${id}`);
  const mine = ++token;
  detailEl.setAttribute("aria-busy", "true");
  try {
    const [ev, ex] = await Promise.all([api.event(id), api.explain(id, false).catch(() => null)]);
    if (mine !== token) return;
    current = ev;
    renderDetail(detailEl, ev, ex);
  } catch (err) {
    if (mine === token) detailEl.innerHTML = `<p class="fail">Could not load event ${esc(id)}: ${esc(err.message)}</p>`;
  } finally {
    if (mine === token) detailEl.removeAttribute("aria-busy");
  }
}

const hashId = () => {
  const m = location.hash.match(/event=(\d+)/);
  return m ? Number(m[1]) : null;
};

listEl.addEventListener("click", (e) => {
  const b = e.target.closest(".pick");
  if (b) select(Number(b.dataset.id));
});
listEl.addEventListener("change", (e) => {
  const t = e.target.closest(".tick");
  if (!t) return;
  const id = Number(t.dataset.id);
  if (t.checked) reviewed.add(id);
  else reviewed.delete(id);
  t.closest(".row").classList.toggle("done", t.checked);
  saveReviewed();
});
addEventListener("hashchange", () => select(hashId()));
let rz;
addEventListener("resize", () => {
  clearTimeout(rz);
  rz = setTimeout(() => current && drawChart(detailEl, current), 120);
});

(async () => {
  try {
    const [summary, list, aud] = await Promise.all([api.summary(), api.events(), audit()]);
    status(summary, list.events, aud);
    renderList(list.events);
    const want = hashId();
    const ids = new Set(list.events.map((e) => e.event_id));
    select(want != null && ids.has(want) ? want : list.events[0]?.event_id);
  } catch (err) {
    $("status").textContent = "";
    const b = $("banner");
    b.textContent = err.message;
    b.hidden = false;
  }
})();
