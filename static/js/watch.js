// Second Look · Watch: a calm stage that only raises its voice for a Critical encounter.
// Data: /api/summary and /api/events (docs/CONTRACT.md); the replay clock is the dashboard's (js/clock.js, js/state.js).
// Deep links for demos and screenshots: #demo=482 opens that alert straight away; #t=0.9 starts the replay at T+0.9 d.
import { api } from "./api.js";
import { initClock } from "./clock.js";
import { esc, fmtDist } from "./fmt.js";
import { set, state, subscribe } from "./state.js";
import { boxWidth, hideAlert, initAlert, showAlert, shown, updateRemaining } from "./watch-alert.js";
import { createStage } from "./watch-stage.js";

const ALERT_DAYS = 1.0; // a Critical alerts when the replay brings it inside 24 h of closest approach
const QUEUE_N = 6;
const $ = (id) => document.getElementById(id);
const stageEl = $("stage"), tip = $("tip");

const acked = new Set();
let crits = []; // tier-2 events, list shape
let pending = []; // Criticals that crossed the window while another alert was open
let resume = false; // the alert interrupted playback; resume on acknowledge
let prevElapsed = 0;

const remaining = (e) => e.latest.time_to_tca_days - state.elapsed;
const fmtT = (d) => `${d.toFixed(2)} d`;

const stage = createStage($("watch-canvas"), {
  remaining,
  isAcked: (id) => acked.has(id),
  onPick: (e) => { if (e.tier === 2) openAlert(e); },
  onHover: (e, x, y) => {
    if (!e) return void (tip.hidden = true);
    const L = e.latest, rem = remaining(e);
    tip.innerHTML = `<b>Event ${esc(e.event_id)}</b> <span class="m">· ${esc(L.object_type.toLowerCase())}</span><br>` +
      `${esc(e.tier_name)}${e.tier === 2 ? (acked.has(e.event_id) ? " · acknowledged" : " · click to open") : ""}<br>` +
      `<span class="m">miss</span> ${fmtDist(L.miss_distance_m)} <span class="m">· TCA</span> ${rem > 0 ? `in ${fmtT(rem)}` : "passed"}`;
    tip.hidden = false;
    const r = stageEl.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
  },
});

function openAlert(e, { fromReplay = false } = {}) {
  if (fromReplay && state.playing) resume = true;
  if (state.playing) set({ playing: false });
  tip.hidden = true;
  stageEl.classList.remove("alerting");
  void stageEl.offsetWidth; // restart the 3-pulse frame
  stageEl.classList.add("alerting", "boxed");
  showAlert(e, { remaining, summary: state.summary, pendingCount: pending.length });
  stage.setInset(boxWidth());
  stage.focus(e);
  paintQueue();
}

function closeAlert({ ack }) {
  const e = shown();
  if (!e) return;
  if (ack) acked.add(e.event_id);
  hideAlert();
  stageEl.classList.remove("alerting", "boxed");
  stage.setInset(0);
  stage.unfocus();
  // Criticals that crossed their window meanwhile come next; otherwise pick the replay back up.
  pending = pending.filter((p) => !acked.has(p.event_id) && remaining(p) > 0);
  if (ack && pending.length) {
    const next = pending.shift();
    setTimeout(() => openAlert(next), 450);
    return;
  }
  pending = [];
  if (resume && ack) set({ playing: true });
  resume = false;
  paintQueue();
}

initAlert({ onAck: () => closeAlert({ ack: true }), onDismiss: () => closeAlert({ ack: false }) });

function onTick() {
  const now = state.elapsed;
  if (state.playing && now > prevElapsed) {
    const crossed = crits
      .filter((e) => !acked.has(e.event_id) && e.latest.time_to_tca_days - prevElapsed > ALERT_DAYS && remaining(e) <= ALERT_DAYS && remaining(e) > 0)
      .sort((a, b) => remaining(a) - remaining(b));
    if (crossed.length) {
      if (shown()) pending.push(...crossed);
      else {
        pending.push(...crossed.slice(1));
        // After clock.js's tick has queued its next frame, so the pause cancels that frame.
        queueMicrotask(() => openAlert(crossed[0], { fromReplay: true }));
      }
    }
  }
  prevElapsed = now;
  const cur = shown();
  if (cur) updateRemaining(remaining(cur));
  paintCountdown();
  paintQueue();
  stage.requestDraw();
}

function paintCountdown() {
  const next = crits.filter((e) => remaining(e) > 0).sort((a, b) => remaining(a) - remaining(b))[0];
  if (!next) {
    $("countdown").innerHTML = "T− <span>—</span>";
    $("countdown-cap").textContent = "No Critical closest approach left in the 7-day replay.";
    return;
  }
  const r = remaining(next), L = next.latest;
  $("countdown").innerHTML = `T− <span>${r.toFixed(2)}</span> d`;
  $("countdown-cap").innerHTML =
    `to the next Critical closest approach: <b>event ${esc(next.event_id)}</b>, ${esc(L.object_type.toLowerCase())}, ${fmtDist(L.miss_distance_m)} miss.<br>` +
    `An alert opens 24 h before each Critical closest approach.`;
}

// The queue is keyed so playback doesn't rebuild the buttons (keeps keyboard focus).
let queueKey = "";
function paintQueue() {
  const up = crits.filter((e) => remaining(e) > 0).sort((a, b) => remaining(a) - remaining(b));
  const top = up.slice(0, QUEUE_N);
  const cur = shown();
  const key = top.map((e) => `${e.event_id}${acked.has(e.event_id) ? "a" : ""}${cur === e ? "c" : ""}`).join(",");
  $("q-count").textContent = `${up.length} ahead`;
  if (key !== queueKey) {
    queueKey = key;
    $("q-list").innerHTML = top.map((e) => {
      const L = e.latest, a = acked.has(e.event_id);
      return `<li><button type="button" class="qrow" data-id="${e.event_id}" ${cur === e ? 'aria-current="true"' : ""}
        aria-label="Open event ${e.event_id}: ${esc(L.object_type.toLowerCase())}, ${fmtDist(L.miss_distance_m)} miss">
        <span class="mk crit ${a ? "hollow" : ""}" aria-hidden="true"></span><span>${e.event_id}</span>
        <span class="obj">${esc(L.object_type.toLowerCase())} · ${fmtDist(L.miss_distance_m)}</span>
        <span class="t">${a ? '<span class="ack">ACK</span> ' : ""}<span data-t></span></span></button></li>`;
    }).join("") || '<li class="q-note">No Critical left in the replay window.</li>';
  }
  for (const btn of $("q-list").querySelectorAll(".qrow")) {
    const e = crits.find((c) => c.event_id === Number(btn.dataset.id));
    btn.querySelector("[data-t]").textContent = `T− ${fmtT(remaining(e))}`;
  }
}
$("q-list").addEventListener("click", (ev) => {
  const b = ev.target.closest(".qrow");
  if (b) openAlert(crits.find((c) => c.event_id === Number(b.dataset.id)));
});

function paintKeys(summary) {
  const t = summary.by_tier;
  const n = (v) => Number(v || 0).toLocaleString("en");
  $("keys").innerHTML =
    `<li><span class="mk own"></span>Our satellite</li>` +
    `<li><span class="mk crit"></span><b>${n(t.Critical)}</b> Critical</li>` +
    `<li><span class="mk elev"></span><b>${n(t.Elevated)}</b> Elevated</li>` +
    `<li><span class="mk below"></span><b>${n(t["Below threshold"])}</b> Below threshold, faint</li>` +
    `<li>Rings: 1 km · 5 km at closest approach</li>`;
  $("q-note").textContent = "Soonest closest approach first. Pick one to open its alert.";
}

async function main() {
  const [summary, list] = await Promise.all([api.summary(), api.events()]);
  set({ summary, events: list.events });
  crits = list.events.filter((e) => e.tier === 2);
  // Draw quiet tiers first so Criticals sit on top.
  stage.setEvents(list.events);
  paintKeys(summary);
  initClock();
  subscribe(["elapsed"], onTick);
  subscribe(["playing"], () => {
    // Pressing Play with an alert open means "carry on": dismiss it.
    if (state.playing && shown()) closeAlert({ ack: false });
  });
  onTick();

  const [k, v] = location.hash.slice(1).split("=");
  if (k === "t" && v) set({ elapsed: Math.max(0, Math.min(7, Number(v) || 0)) }); // #t=0.9: start the replay there
  if (k === "demo" && v) {
    const e = list.events.find((x) => x.event_id === Number(v));
    if (e) {
      // Put the replay just inside the event's 24 h window, as if the clock had just crossed it.
      set({ elapsed: Math.max(0, Math.min(7, e.latest.time_to_tca_days - ALERT_DAYS * 0.98)) });
      openAlert(e);
    }
  }
}

main().catch((err) => {
  $("countdown-cap").textContent = "Could not load encounters.";
  const b = $("banner");
  b.textContent = err.message;
  b.hidden = false;
});
