// Review page: three figures up top, the queues on the left (Monitor folded), the selected event on the right. Supports #event=<id>.
// The analyst decides; this page only shows the queue, the evidence and the decision record behind each tier.
import { api } from "./api.js";
import { esc, fmtDist, fmtDays } from "./fmt.js";
import { renderDetail, drawChart, reasonOf } from "./review-detail.js";

const QUEUES = ["MANEUVER PLANNING", "ANALYST REVIEW", "MONITOR"];
const FOLDED = "MONITOR"; // collapsed to one line until asked for: nothing in it needs a decision now
const KEY = "second-look.reviewed.v1";

const $ = (id) => document.getElementById(id);
const listEl = $("list"), detailEl = $("detail");
let selected = null, current = null, token = 0;
let groups = {}, queueOf = new Map(), foldOpen = false;

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
  const delta = after - before;
  const cut = before ? Math.round((1 - after / before) * 100) : 0;
  const w = summary.warnings_24h || {};
  const minTca = Math.min(...events.map((e) => e.latest?.time_to_tca_days ?? Infinity));
  const within = w.within_dangerous_distance ?? 0;
  const winNote = !w.events_in_window && Number.isFinite(minTca)
    ? `No CDM is under ${minTca.toFixed(1)} d to TCA`
    : `${n(w.events_in_window || 0)} events in the 24 h window`;
  let inv = "";
  if (aud) {
    const pass = aud.status === "PASS";
    const checks = aud.checks || [];
    const ok = checks.filter((c) => c.passed).length;
    const failed = checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
    inv = `<span class="seg" title="Safety invariants checked over every event${failed ? `; failed: ${esc(failed)}` : ""}">Invariants <b class="${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL"}</b> <span class="muted num">${ok}/${checks.length}</span></span>`;
  }
  $("status").innerHTML = `
    <span class="seg" title="Elevated or Critical: ${n(before)} by the rule, ${n(after)} after Second Look (${cut}% fewer)">To review <b class="num">${n(after)}</b> <span class="muted num">(${delta <= 0 ? "\u2212" : "+"}${n(Math.abs(delta))})</span></span>
    <span class="seg" title="${esc(winNote)}">Next 24 h: <b class="num${within ? " warn" : ""}">${n(within)}</b> within 1 km</span>
    ${inv}`;
}

function row(e) {
  const done = reviewed.has(e.event_id);
  const why = reasonOf(e);
  const L = e.latest || {};
  return `<li class="row${done ? " done" : ""}" data-id="${e.event_id}">
    <input type="checkbox" class="tick" data-id="${e.event_id}" ${done ? "checked" : ""} aria-label="Event ${e.event_id} reviewed" title="Reviewed">
    <button type="button" class="pick" data-id="${e.event_id}" aria-label="Event ${e.event_id}, ${esc(why.long)}">
      <span class="id num">${e.event_id}</span>
      <span class="chip ${why.cls}">${esc(why.short)}</span>
      <span class="r num">${L.miss_distance_m != null ? esc(fmtDist(L.miss_distance_m)) : "n/a"}</span>
      <span class="r num muted">${L.time_to_tca_days != null ? esc(fmtDays(L.time_to_tca_days)) : "n/a"}</span>
    </button></li>`;
}

const rows = (q) => (groups[q].length ? `<ul>${groups[q].map(row).join("")}</ul>` : `<p class="muted small">Nothing in this queue.</p>`);

function section(q) {
  const label = q.charAt(0) + q.slice(1).toLowerCase();
  if (q !== FOLDED) {
    return `<section class="q" aria-label="${label}"><h2>${label} <span class="count num">${n(groups[q].length)}</span></h2>${rows(q)}</section>`;
  }
  return `<section class="q fold${foldOpen ? " open" : ""}" aria-label="${label}">
    <h2><button type="button" class="fold-btn" aria-expanded="${foldOpen}" aria-controls="fold-rows">${label} <span class="count"><span class="num">${n(groups[q].length)}</span> <span class="act">${foldOpen ? "hide" : "show"}</span></span></button></h2>
    <div id="fold-rows">${foldOpen ? rows(q) : ""}</div></section>`;
}

function renderList(events) {
  groups = Object.fromEntries(QUEUES.map((q) => [q, []]));
  for (const e of events) {
    const q = groups[e.action?.queue] ? e.action.queue : "ANALYST REVIEW";
    groups[q].push(e);
    queueOf.set(e.event_id, q);
  }
  listEl.innerHTML = `<div class="cols-h" aria-hidden="true"><span></span><span>Event</span><span>Reason</span><span class="r">Miss</span><span class="r">TCA in</span></div>` +
    QUEUES.map(section).join("");
}

function setFold(open) {
  foldOpen = open;
  const sec = listEl.querySelector(".q.fold");
  if (!sec) return;
  sec.outerHTML = section(FOLDED);
  if (selected != null) mark(selected, false);
}

function mark(id, scroll = true) {
  if (!foldOpen && queueOf.get(id) === FOLDED) setFold(true);
  listEl.querySelectorAll('.row[aria-current="true"]').forEach((r) => r.removeAttribute("aria-current"));
  const r = listEl.querySelector(`.row[data-id="${id}"]`);
  if (r) {
    r.setAttribute("aria-current", "true");
    if (scroll) r.scrollIntoView({ block: "nearest" });
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
  if (e.target.closest(".fold-btn")) return setFold(!foldOpen);
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
