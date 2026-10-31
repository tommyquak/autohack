// Collapse handles for the left (events) and right (selected event) panels. They work on every tab.
// Each tab remembers its own state (localStorage, optional). The globe starts with both panels collapsed
// because its card is the detail; every other tab starts with both open.

const CHEV = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>`;
const KEY = "rails-hidden";
const SIDES = [
  ["left", "hide-left", "events"],
  ["right", "hide-right", "selected-event"],
];
const DEFAULT = { globe: ["hide-left", "hide-right"] };

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
};
const save = (saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
};

export function initRails() {
  const layout = document.querySelector(".layout");
  const stage = layout.querySelector(".stage");
  const tabs = document.getElementById("tabs");
  const saved = load();
  let tab = tabs.querySelector('[aria-selected="true"]')?.dataset.tab || "";

  const buttons = SIDES.map(([side, cls, name]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `rail-toggle ${side}`;
    b.innerHTML = CHEV;
    stage.append(b);
    b.addEventListener("click", () => {
      layout.classList.toggle(cls);
      saved[tab] = SIDES.map((s) => s[1]).filter((c) => layout.classList.contains(c));
      save(saved);
      paint();
      window.dispatchEvent(new Event("resize")); // canvases size themselves to the stage
    });
    return [b, cls, name];
  });

  function paint() {
    for (const [b, cls, name] of buttons) {
      const off = layout.classList.contains(cls);
      b.setAttribute("aria-expanded", String(!off));
      b.setAttribute("aria-label", `${off ? "Expand" : "Collapse"} the ${name} panel`);
      b.title = b.getAttribute("aria-label");
    }
  }

  function apply() {
    const hidden = saved[tab] ?? DEFAULT[tab] ?? [];
    for (const [, cls] of SIDES) layout.classList.toggle(cls, hidden.includes(cls));
    paint();
    window.dispatchEvent(new Event("resize"));
  }

  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tab]");
    if (!btn) return;
    tab = btn.dataset.tab;
    apply();
  });
  apply();
}
