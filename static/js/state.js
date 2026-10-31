// Tiny store: views subscribe to the keys they depend on, so scrubbing the clock doesn't rebuild the filter UI.
export const state = {
  summary: null,
  events: [], // /api/events, urgency order, no history
  metrics: null,
  filters: { tiers: new Set([0, 1, 2]), review: false, type: "", slot: null, lat: null },
  selectedId: null,
  mode: "model", // funnel shows tiers from "baseline" (the rule) or "model"
  elapsed: 0, // replay clock, days since the snapshot
  playing: false,
  speed: 0.25, // replay days per real second
};

const subs = [];
export function subscribe(keys, fn) {
  subs.push({ keys: new Set(keys), fn });
}
export function set(patch) {
  const changed = Object.keys(patch);
  Object.assign(state, patch);
  for (const s of subs) if (changed.some((k) => s.keys.has(k))) s.fn();
}
// Mutating filters in place needs an explicit notify.
export const touchFilters = () => set({ filters: state.filters });

export const remaining = (e) => e.latest.time_to_tca_days - state.elapsed;

export function passesFilters(e) {
  const f = state.filters;
  if (!f.tiers.has(e.tier)) return false;
  if (f.review && !e.needs_review) return false;
  if (f.type && e.latest.object_type !== f.type) return false;
  if (f.lat !== null) {
    const v = e.latest.geocentric_latitude_deg;
    if (v == null || Math.min(35, Math.max(0, Math.floor((v + 90) / 5))) !== f.lat) return false;
  }
  if (f.slot !== null) {
    const r = remaining(e);
    if (r < f.slot * 0.5 || r >= (f.slot + 1) * 0.5) return false;
  }
  return true;
}

// Events that haven't reached TCA yet in the replay.
export const upcoming = () => state.events.filter((e) => remaining(e) > 0);
export const visible = () => state.events.filter((e) => remaining(e) > 0 && passesFilters(e));
