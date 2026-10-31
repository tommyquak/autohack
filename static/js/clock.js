// Replay clock: moves "now" forward through the 7-day horizon so events slide toward closest approach.
import { MAX_DAYS } from "./fmt.js";
import { set, state, subscribe } from "./state.js";

const root = document.getElementById("clock");
const SPEEDS = [0.25, 1, 3]; // replay days per real second
let raf = 0, last = 0;

export function initClock() {
  root.innerHTML = `
    <button type="button" id="c-play" aria-pressed="false">Play</button>
    <button type="button" id="c-reset">Reset</button>
    <input type="range" id="c-scrub" min="0" max="${MAX_DAYS}" step="0.01" value="0" aria-label="Replay time in days">
    <span class="t num" id="c-t"></span>
    <span class="speeds" role="group" aria-label="Replay speed, days per second">${SPEEDS.map((s) => `<button type="button" data-speed="${s}" aria-pressed="${s === state.speed}">${s}d/s</button>`).join("")}</span>`;
  const play = root.querySelector("#c-play"), scrub = root.querySelector("#c-scrub");
  play.addEventListener("click", () => {
    if (!state.playing && state.elapsed >= MAX_DAYS) set({ elapsed: 0 });
    set({ playing: !state.playing });
  });
  root.querySelector("#c-reset").addEventListener("click", () => set({ elapsed: 0, playing: false }));
  scrub.addEventListener("input", () => set({ elapsed: Number(scrub.value), playing: false }));
  root.querySelectorAll("[data-speed]").forEach((b) =>
    b.addEventListener("click", () => {
      set({ speed: Number(b.dataset.speed) });
      root.querySelectorAll("[data-speed]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }),
  );
  subscribe(["elapsed"], paint);
  subscribe(["playing"], () => {
    play.textContent = state.playing ? "Pause" : "Play";
    play.setAttribute("aria-pressed", state.playing);
    if (state.playing) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else cancelAnimationFrame(raf);
  });
  paint();
}

function tick(now) {
  const next = Math.min(MAX_DAYS, state.elapsed + ((now - last) / 1000) * state.speed);
  last = now;
  set({ elapsed: next });
  if (next >= MAX_DAYS) set({ playing: false });
  else raf = requestAnimationFrame(tick);
}

function paint() {
  root.querySelector("#c-scrub").value = state.elapsed;
  root.querySelector("#c-t").textContent = state.elapsed === 0 ? "NOW · snapshot" : `T+${state.elapsed.toFixed(2)} d · replay`;
}
