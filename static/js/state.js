// Tiny store: views subscribe to the keys they depend on, so scrubbing the clock doesn't rebuild the filter UI.
import { latBand } from "./fmt.js";

export const state = {
  summary: null,
  events: [], // /api/events, urgency order, no history
  metrics: null,
  filters: { tiers: new Set([0, 1, 2]), review: false, type: "", slot: null, lat: null },
  sort: "urgency", // queue order: urgency (the API order: tier, then soonest) | soonest | action
  selectedId: null,
  mode: "model", // funnel shows tiers from "baseline" (the rule) or "model"
  horizon: "final", // tier every view shows: "final" = forecast final tier at TCA (triage.forecast), "now" = latest message
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

// The tier shown, and the tier it came from (the funnel morphs from one to the other):
// "final": the forecast final tier, from its rule floor (the forecaster may only escalate);
// "now": the team nowcast at the latest message, from the conservative rule (the nowcast may only demote).
const final = (e) => state.horizon === "final" && e.forecast != null;
export const tierOf = (e) => (final(e) ? e.forecast.predicted_final_tier : e.tier);
export const baseOf = (e) => (final(e) ? e.forecast.floor_tier : e.baseline_tier);

export function passesFilters(e) {
  const f = state.filters;
  if (!f.tiers.has(tierOf(e))) return false;
  if (f.review && !e.needs_review) return false;
  if (f.type && e.latest.object_type !== f.type) return false;
  if (f.lat !== null) {
    const v = e.latest.geocentric_latitude_deg;
    if (v == null || latBand(v) !== f.lat) return false;
  }
  if (f.slot !== null) {
    const r = remaining(e);
    if (r < f.slot * 0.5 || r >= (f.slot + 1) * 0.5) return false;
  }
  return true;
}

// Events that haven't reached TCA yet in the replay.
export const upcoming = () => state.events.filter((e) => remaining(e) > 0);
const ACTION_RANK = { "MANEUVER PLANNING": 0, "ANALYST REVIEW": 1, MONITOR: 2 };
export function visible() {
  const rows = state.events.filter((e) => remaining(e) > 0 && passesFilters(e));
  // Urgency = shown tier, then soonest TCA (the API order for "now"); the sorts are stable, so ties keep the API order.
  if (state.sort === "urgency") rows.sort((a, b) => tierOf(b) - tierOf(a) || remaining(a) - remaining(b));
  else if (state.sort === "soonest") rows.sort((a, b) => remaining(a) - remaining(b));
  else if (state.sort === "action") rows.sort((a, b) => (ACTION_RANK[a.action?.queue] ?? 3) - (ACTION_RANK[b.action?.queue] ?? 3) || remaining(a) - remaining(b));
  return rows;
}
