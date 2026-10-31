// Encounter (3D) and Compare tabs (owner: Integration & trust). Adds its own tabs and panels, so the
// dashboard only needs `initEncounter()`. Plotly (vendored) and close_approach.js load the first time a tab opens.
import { api } from "./api.js";
import { TIERS, esc } from "./fmt.js";
import { state, subscribe } from "./state.js";

// Vendored so the demo doesn't depend on venue Wi-Fi (sha512 matches cdnjs); the CDN is only a fallback.
const PLOTLY = ["/static/vendor/plotly-3.1.0.min.js", "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/3.1.0/plotly.min.js"];
const pinned = []; // event ids in the Compare tab, in the order they were added
let lib = null; // Promise<CloseApproach>
let token = 0; // drops renders that a newer selection has overtaken

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, onload: resolve });
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

function loadLib() {
  lib ||= (window.Plotly ? Promise.resolve() : loadScript(PLOTLY[0]).catch(() => loadScript(PLOTLY[1])))
    .then(() => loadScript("/static/close_approach.js"))
    .then(() => {
      const css = getComputedStyle(document.documentElement);
      const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      window.CloseApproach.theme({
        below: TIERS[0].color, warning: TIERS[1].color, critical: TIERS[2].color,
        text: v("--ink", "#e6ebe8"), muted: v("--muted", "#7d8a85"), grid: v("--hair2", "#2a3532"), surface: v("--bg", "#080a0b"),
      });
      return window.CloseApproach;
    })
    .catch((err) => ((lib = null), Promise.reject(err)));
  return lib;
}

const panel = (tab) => document.getElementById(`panel-${tab}`);
const isOpen = (tab) => panel(tab) && !panel(tab).hidden;

function addTabs() {
  const tabs = document.getElementById("tabs");
  const stage = tabs.parentElement;
  for (const [tab, label] of [["encounter", "Encounter (3D)"], ["compare", "Compare"]]) {
    tabs.insertAdjacentHTML("beforeend", `<button role="tab" aria-selected="false" data-tab="${tab}">${label}</button>`);
    stage.insertAdjacentHTML(
      "beforeend",
      `<div class="panel" id="panel-${tab}" role="tabpanel" hidden>
        <div class="stage-bar enc-bar"></div><div class="enc-view"></div></div>`,
    );
  }
  // Generic switching for every tab in #tabs, including any added later (data-tab="x" -> #panel-x).
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tab]");
    if (!btn) return;
    for (const b of tabs.querySelectorAll("[data-tab]")) {
      const on = b === btn;
      b.setAttribute("aria-selected", String(on));
      if (panel(b.dataset.tab)) panel(b.dataset.tab).hidden = !on;
    }
    if (btn.dataset.tab === "encounter") renderEncounter();
    if (btn.dataset.tab === "compare") renderCompare();
  });
}

function fail(view, err) {
  view.innerHTML = `<p class="muted">View unavailable (${esc(err.message)}). The figures in the other panels are unaffected.</p>`;
}

function pinButton(id) {
  if (id == null) return "";
  if (pinned.includes(id)) return `<span class="muted">Event ${id} is in Compare</span>`;
  if (pinned.length >= 3) return `<span class="muted">Compare is full (3 events)</span>`;
  return `<button type="button" class="link" data-pin="${id}">Add event ${id} to Compare</button>`;
}

async function renderEncounter() {
  if (!isOpen("encounter")) return;
  const id = state.selectedId, mine = ++token;
  const bar = panel("encounter").querySelector(".enc-bar"), view = panel("encounter").querySelector(".enc-view");
  bar.innerHTML = pinButton(id);
  if (id == null) return void (view.innerHTML = '<p class="muted">Pick an event from the queue or click a dot.</p>');
  try {
    const [CA, event] = await Promise.all([loadLib(), api.event(id)]);
    if (mine === token) await CA.render3d(view, event);
  } catch (err) {
    if (mine === token) fail(view, err);
  }
}

async function renderCompare() {
  if (!isOpen("compare")) return;
  const id = state.selectedId;
  const bar = panel("compare").querySelector(".enc-bar"), view = panel("compare").querySelector(".enc-view");
  bar.innerHTML =
    pinned.map((p) => `<button type="button" class="chip-x" data-unpin="${p}" aria-label="Remove event ${p}">${p} ×</button>`).join("") +
    pinButton(id);
  if (!pinned.length) {
    view.innerHTML = '<p class="muted">Add up to 3 events to compare their miss distance and Pc over the updates.</p>';
    return;
  }
  const mine = ++token;
  try {
    const [CA, events] = await Promise.all([loadLib(), Promise.all(pinned.map((p) => api.event(p)))]);
    if (mine === token) await CA.renderCompare(view, events);
  } catch (err) {
    if (mine === token) fail(view, err);
  }
}

export function initEncounter() {
  addTabs();
  document.getElementById("tabs").parentElement.addEventListener("click", (ev) => {
    const pin = ev.target.closest("[data-pin]"), unpin = ev.target.closest("[data-unpin]");
    if (pin && pinned.length < 3) pinned.push(Number(pin.dataset.pin));
    if (unpin) pinned.splice(pinned.indexOf(Number(unpin.dataset.unpin)), 1);
    if (pin || unpin) (isOpen("compare") ? renderCompare() : renderEncounter());
  });
  subscribe(["selectedId"], () => (renderEncounter(), renderCompare()));
  // Deep link for the demo: /#encounter, /#compare=482,796
  const [tab, ids] = location.hash.slice(1).split("=");
  if (tab === "compare" && ids) pinned.push(...ids.split(",").map(Number).filter(Boolean).slice(0, 3));
  document.querySelector(`#tabs [data-tab="${CSS.escape(tab)}"]`)?.click();
}
