// Ask bar: the operator copilot (POST /chat, NDJSON; docs/CONTRACT.md §5) inside the dashboard.
// Answers come from read-only triage tools, by Claude or by the deterministic local fallback; the bar always says which.
// A `focus_event` tool call selects that event on the dashboard. Answer text is rendered as text, never as HTML.
import { esc } from "./fmt.js";
import { set, state } from "./state.js";

// Phrasings the local fallback routes correctly (and that read fine for Claude too).
const CHIPS = [
  { label: "Summary", ask: () => "summary" },
  { label: "Critical events", ask: () => "Which events are Critical?" },
  { label: "Needs review", ask: () => "Which events need review?" },
  { label: "Model performance", ask: () => "How well does the model perform?" },
  { label: "Explain selected event", ask: () => (state.selectedId == null ? null : `event ${state.selectedId}`) },
];

let root, form, input, sendBtn, card, body, srcEl, evidenceEl, health = null;
let sessionId = null, running = false;

export function initAsk() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/ask.css" });
  document.head.append(css);

  document.querySelector(".stage").insertAdjacentHTML(
    "beforeend",
    `<section class="ask" id="ask" aria-label="Ask the copilot">
      <div class="ask-card" id="ask-card" hidden>
        <div class="ask-card-head">
          <span class="ask-src" id="ask-src"></span>
          <button type="button" class="ask-x" id="ask-close" aria-label="Close answer">×</button>
        </div>
        <div class="ask-body" id="ask-body" aria-live="polite"></div>
        <p class="ask-evidence" id="ask-evidence"></p>
      </div>
      <div class="ask-chips" id="ask-chips"></div>
      <form class="ask-form" id="ask-form">
        <label class="sr" for="ask-input">Ask a question about these events</label>
        <input id="ask-input" type="text" autocomplete="off" placeholder="Ask about these events, e.g. which events are Critical?">
        <button type="submit" id="ask-send">Ask</button>
        <button type="button" class="ask-new" id="ask-new" title="Start a new conversation">New</button>
        <span class="ask-health" id="ask-health"></span>
      </form>
    </section>`,
  );
  root = document.getElementById("ask");
  form = document.getElementById("ask-form");
  input = document.getElementById("ask-input");
  sendBtn = document.getElementById("ask-send");
  card = document.getElementById("ask-card");
  body = document.getElementById("ask-body");
  srcEl = document.getElementById("ask-src");
  evidenceEl = document.getElementById("ask-evidence");

  const chips = document.getElementById("ask-chips");
  chips.innerHTML = CHIPS.map((c, i) => `<button type="button" data-i="${i}">${esc(c.label)}</button>`).join("");
  chips.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || running) return;
    const q = CHIPS[Number(b.dataset.i)].ask();
    if (q) run(q);
    else input.focus();
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (q && !running) run(q);
  });
  document.getElementById("ask-close").addEventListener("click", () => (card.hidden = true));
  document.getElementById("ask-new").addEventListener("click", reset);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !card.hidden && root.contains(document.activeElement)) card.hidden = true;
  });
  paintHealth();
}

// Which engine is behind the bar, before any question is asked.
async function paintHealth() {
  const el = document.getElementById("ask-health");
  try {
    health = await (await fetch("/health")).json();
    el.textContent = health.llm === "claude" ? "Claude" : "Local fallback, no language model";
    el.title = `reports: ${health.reports}`;
  } catch {
    el.textContent = "";
  }
}

async function reset() {
  try {
    await fetch("/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "", session_id: sessionId }) });
  } catch {
    /* the next question starts a fresh session either way */
  }
  sessionId = null;
  card.hidden = true;
  input.value = "";
}

// Plain text with "- " lines shown as a list; textContent only, so a tool result can never inject markup.
function paint(text) {
  body.textContent = "";
  let ul = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) {
      if (!ul) body.append((ul = document.createElement("ul")));
      ul.append(Object.assign(document.createElement("li"), { textContent: line.slice(2) }));
    } else {
      ul = null;
      if (line.trim()) body.append(Object.assign(document.createElement("p"), { textContent: line }));
    }
  }
}

async function run(message) {
  running = true;
  sendBtn.disabled = true;
  input.value = "";
  card.hidden = false;
  srcEl.textContent = "Asking…";
  evidenceEl.textContent = "";
  body.textContent = "";
  let text = "", source = null, focused = null;
  const tools = [];
  const done = () => {
    const label = source === "claude" ? "Answered by Claude" : source === "fallback" ? "Answered by the local fallback, no language model" : "";
    srcEl.textContent = label ? `${label} · ${message}` : message;
    evidenceEl.textContent = [tools.length ? `From ${[...new Set(tools)].join(", ")}.` : "", focused != null ? `Showing event ${focused}.` : ""].filter(Boolean).join(" ");
  };
  try {
    const res = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, session_id: sessionId }) });
    if (!res.ok || !res.body) throw new Error(`/chat -> ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "session") sessionId = e.session_id;
        else if (e.type === "source") source = e.source;
        else if (e.type === "text") paint((text += e.text));
        else if (e.type === "tool_call") {
          if (e.name === "focus_event") {
            const id = Number(e.input?.event_id);
            if (state.events.some((x) => x.event_id === id)) {
              focused = id;
              set({ selectedId: id });
            }
          } else tools.push(e.name);
        } else if (e.type === "error") paint(`${text}${text ? "\n" : ""}Could not answer: ${e.text}`);
      }
    }
  } catch (err) {
    paint(`Could not reach the copilot: ${err.message}`);
  } finally {
    done();
    running = false;
    sendBtn.disabled = false;
    paintHealth();
    input.focus();
  }
}
