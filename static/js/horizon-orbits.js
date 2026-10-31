// Horizon view: Keplerian orbits from each CDM's real orbital elements, plus the replay timeline of the classification
// cases. Pure functions, no three.js.
//
// Units: lengths in Earth radii (R_E = 6371 km = 1), angles in radians, `tau` = simulated seconds.
// World axes follow three.js: +Y is the north pole. From the data (latest CDM, display-only columns): semi-major axis,
// eccentricity and inclination of both objects, the conjunction latitude, relative speed, mission, and every CDM update.
// NOT in the data: RAAN, argument of perigee, longitude. They are set so both objects meet at the real latitude.

export const GM = 398600.4418; // km^3/s^2
export const R_E = 6371; // km
export const SPEED = 200; // simulated seconds per replay second while cruising
export const CASE_SPEED = 40; // ... and inside a case window (one factor for everything at any instant)
// Case window around each closest approach (simulated seconds relative to TCA)
export const CASE = { flyIn: -640, held: -520, cdmFirst: -500, cdmLast: -140, out: 70, end: 170 };
const MIN_GAP_TAU = 1500; // simulated seconds between closest approaches (room for a case window + cruise)
const FIRST_TCA_TAU = 1500;
const deg = Math.PI / 180;

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => v3.mul(a, 1 / (v3.len(a) || 1)),
};
export const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const median = (xs) => { const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };

// ---------- Kepler ----------
const E_of_M = (M, e) => { let E = e < 0.8 ? M : Math.PI; for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); return E; };
const nu_of_E = (E, e) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
const E_of_nu = (nu, e) => 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
const M_of_nu = (nu, e) => { const E = E_of_nu(nu, e); return E - e * Math.sin(E); };

/**
 * An elliptical orbit. `a` in Earth radii, P/Q = perigee / 90-degrees-ahead unit vectors of the plane, M0 = mean
 * anomaly at tau = 0, shift = a constant translation (used only to remove a sub-km residual at the meeting point).
 * Speed follows vis-viva automatically: position is solved from Kepler's equation in time.
 */
function ellipse(a, e, P, Q, M0, shift = [0, 0, 0]) {
  const aKm = a * R_E, n = Math.sqrt(GM / aKm ** 3);
  const o = {
    a, e, P, Q, M0, n, shift, period: (2 * Math.PI) / n, normal: v3.cross(P, Q),
    rAt(nu) { return (a * (1 - e * e)) / (1 + e * Math.cos(nu)); },
    atNu(nu) { return v3.add(v3.mul(v3.add(v3.mul(P, Math.cos(nu)), v3.mul(Q, Math.sin(nu))), this.rAt(nu)), this.shift); },
    nuAt(tau) { return nu_of_E(E_of_M(this.M0 + n * tau, e), e); },
    pos(tau) { return this.atNu(this.nuAt(tau)); },
    vel(tau) { const d = 0.5; return v3.norm(v3.sub(this.pos(tau + d), this.pos(tau - d))); },
    speedKms(tau) { const r = v3.len(v3.sub(this.pos(tau), this.shift)) * R_E; return Math.sqrt(GM * (2 / r - 1 / aKm)); },
    /** Next tau >= tau0 at which the true anomaly equals nu. */
    tauAtNu(nu, tau0) {
      const M = M_of_nu(nu, e);
      let k = Math.ceil((this.M0 + n * tau0 - M) / (2 * Math.PI));
      let t = (M + 2 * Math.PI * k - this.M0) / n;
      if (t < tau0) t += this.period;
      return t;
    },
  };
  return o;
}

/** Plane from inclination and RAAN; perigee placed at argument `argp` in that plane. */
function planeBasis(inc, raan, argp) {
  const node = [Math.cos(raan), 0, -Math.sin(raan)];
  const north = [0, 1, 0];
  const ahead = v3.norm(v3.add(v3.mul(v3.cross(north, node), Math.cos(inc)), v3.mul(north, Math.sin(inc))));
  const P = v3.add(v3.mul(node, Math.cos(argp)), v3.mul(ahead, Math.sin(argp)));
  const Q = v3.add(v3.mul(node, -Math.sin(argp)), v3.mul(ahead, Math.cos(argp)));
  return { P, Q };
}

const elems = (e, who) => (e.latest.orbit && e.latest.orbit[who]) || null;

/** One of our satellites per mission: median real elements of that mission's events; orientation illustrative. */
function satFor(mission, events, k) {
  const t = events.map((e) => elems(e, "target")).filter(Boolean);
  const smaKm = median(t.map((x) => x.sma_km)) ?? R_E + 700;
  const ecc = Math.min(0.05, median(t.map((x) => x.ecc)) ?? 0.001);
  const incDeg = median(t.map((x) => x.inc_deg)) ?? 97.5;
  const { P, Q } = planeBasis(incDeg * deg, (30 + k * 55) * deg, (40 + k * 70) * deg);
  return { id: mission, smaKm, ecc, incDeg, altKm: smaKm - R_E, orbit: ellipse(smaKm / R_E, ecc, P, Q, k * 1.9) };
}

/** Local east / north at a unit position. */
function enu(p) {
  const north0 = [0, 1, 0];
  let east = v3.cross(north0, p);
  if (v3.len(east) < 1e-6) east = [1, 0, 0];
  east = v3.norm(east);
  return { east, north: v3.norm(v3.cross(p, east)) };
}

/**
 * The other object's orbit: its real sma / ecc / inc, oriented so it is at the conjunction point X (world, Earth
 * radii) at tau. Ascending or descending pass and the sign of the true anomaly are chosen to best match the real
 * relative speed. Returns { orbit, vrelKms }.
 */
function chaserFor(e, X, tau, satOrbit) {
  const c = elems(e, "chaser") || { sma_km: satOrbit.a * R_E, ecc: 0.001, inc_deg: 90 };
  const a = c.sma_km / R_E, ecc = Math.min(0.95, Math.max(0, c.ecc ?? 0));
  const Rs = v3.len(X), p = v3.norm(X);
  const { east, north } = enu(p);
  const cosLat = Math.max(1e-6, Math.hypot(p[0], p[2]));
  const sinA = Math.max(-1, Math.min(1, Math.cos(c.inc_deg * deg) / cosLat));
  const cosA = Math.sqrt(1 - sinA * sinA);
  const cosNu = ecc > 1e-6 ? Math.max(-1, Math.min(1, ((a * (1 - ecc * ecc)) / Rs - 1) / ecc)) : 1;
  const nuAbs = Math.acos(cosNu);
  const vSat = v3.mul(satOrbit.vel(tau), satOrbit.speedKms(tau));
  const want = (e.latest.relative_speed_ms ?? 14000) / 1000;
  let best = null;
  for (const branch of [1, -1]) {
    const d = v3.norm(v3.add(v3.mul(east, sinA), v3.mul(north, branch * cosA)));
    const h = v3.norm(v3.cross(p, d));
    const q = v3.cross(h, p);
    for (const sgn of [1, -1]) {
      const nu = sgn * nuAbs;
      const P = v3.sub(v3.mul(p, Math.cos(nu)), v3.mul(q, Math.sin(nu)));
      const Q = v3.cross(h, P);
      const M = M_of_nu(nu, ecc);
      const o = ellipse(a, ecc, P, Q, 0);
      o.M0 = M - o.n * tau;
      o.shift = v3.sub(X, o.atNu(nu)); // sub-km residual when the two radii differ slightly
      const vrel = v3.len(v3.sub(v3.mul(o.vel(tau), o.speedKms(tau)), vSat));
      if (!best || Math.abs(vrel - want) < Math.abs(best.vrelKms - want)) best = { orbit: o, vrelKms: vrel };
    }
  }
  return best;
}

/** Classification cases: one representative event per kind (482 pinned for "Critical, distance only"). */
export const CASE_KINDS = [
  { key: "dist", label: "Critical · distance only", match: (e) => e.tier === 2 && !pcBacked(e), pin: 482 },
  { key: "pc", label: "Critical · Pc-backed", match: (e) => pcBacked(e) },
  { key: "kept", label: "Elevated · kept by the model", match: (e) => e.tier === 1 && e.certificate?.decision === "kept" },
  { key: "demoted", label: "Elevated → demoted (below threshold)", match: (e) => e.certificate?.decision === "demoted" },
  { key: "watch", label: "Escalation watch", match: (e) => e.action?.escalation_watch },
];
export const pcBacked = (e) => e.tier >= 2 && e.latest.max_risk_estimate_log10 != null && e.latest.max_risk_estimate_log10 >= -4;

export function pickCases(events) {
  const usable = events.filter((e) => e.latest?.orbit?.target && e.latest.geocentric_latitude_deg != null)
    .sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days);
  const used = new Set(), out = [];
  for (const k of CASE_KINDS) {
    let e = k.pin != null ? usable.find((x) => x.event_id === k.pin && k.match(x)) : null;
    e = e || usable.find((x) => !used.has(x.event_id) && k.match(x)); // the soonest of its kind
    if (!e) continue;
    used.add(e.event_id);
    out.push({ kind: k, event: e });
  }
  return out.sort((a, b) => a.event.latest.time_to_tca_days - b.event.latest.time_to_tca_days);
}

/**
 * Plan the replay: a satellite per mission on its real-element orbit; each case's satellite flies on until it next
 * reaches the case's real latitude (after the previous case, so cases keep the real time-to-TCA order); the other
 * object's real-element orbit is oriented to meet it there at that moment. Each CDM update gets a replay time inside
 * the case window, in real time-to-TCA order and proportion (the timeline is compressed, and the page says so).
 */
export function plan(cases, allEvents) {
  const missionIds = [...new Set(cases.map((c) => c.event.latest.mission_id))];
  const sats = missionIds.map((m, k) => satFor(m, allEvents.filter((e) => e.latest.mission_id === m), k));
  const satBy = new Map(sats.map((s) => [s.id, s]));
  let last = -Infinity;
  const raw = cases.map((c) => {
    const e = c.event, sat = satBy.get(e.latest.mission_id), o = sat.orbit;
    const maxLat = Math.min(sat.incDeg, 180 - sat.incDeg) * deg;
    const latDeg = e.latest.geocentric_latitude_deg;
    const lat = Math.max(-maxLat + 1e-4, Math.min(maxLat - 1e-4, latDeg * deg));
    // true anomalies where the orbit is at this latitude: A cos(nu) + B sin(nu) = sin(lat)
    const A = o.P[1], B = o.Q[1], Rr = Math.hypot(A, B), phi = Math.atan2(B, A), d = Math.acos(Math.max(-1, Math.min(1, Math.sin(lat) / Rr)));
    const base = Number.isFinite(last) ? last + MIN_GAP_TAU : 0;
    const tau = Math.min(o.tauAtNu(phi + d, base), o.tauAtNu(phi - d, base));
    last = tau;
    return { c, sat, tau, latDeg, latClamped: Math.abs(latDeg * deg) > maxLat };
  });
  const offset = raw[0].tau - FIRST_TCA_TAU;
  for (const s of sats) s.orbit.M0 += s.orbit.n * offset;

  const encounters = raw.map(({ c, sat, tau: t0, latDeg, latClamped }) => {
    const e = c.event, tau = t0 - offset;
    const X = sat.orbit.pos(tau);
    const { orbit, vrelKms } = chaserFor(e, X, tau, sat.orbit);
    // CDM updates (history) mapped into the case window by their real time to TCA (earliest -> cdmFirst).
    const hist = (e.history || []).slice().sort((p, q) => q.time_to_tca_days - p.time_to_tca_days);
    const tMax = hist.length ? hist[0].time_to_tca_days : 7, tMin = hist.length ? hist[hist.length - 1].time_to_tca_days : 2;
    const span = Math.max(1e-6, tMax - tMin);
    const cdms = hist.map((h, i) => ({
      ...h, n: i + 1, N: hist.length,
      tau: tau + CASE.cdmFirst + ((tMax - h.time_to_tca_days) / span) * (CASE.cdmLast - CASE.cdmFirst),
    }));
    if (cdms.length === 1) cdms[0].tau = tau + CASE.cdmLast;
    return {
      id: e.event_id, event: e, kind: c.kind, sat, tau, latDeg, latClamped, orbit, vrelKms, cdms,
      type: ({ DEBRIS: "debris", PAYLOAD: "payload", "ROCKET BODY": "rocket_body" })[e.latest.object_type] || "unknown",
      pcBacked: pcBacked(e),
    };
  });
  const endTau = encounters[encounters.length - 1].tau + 1200;
  return { sats, encounters, endTau };
}

/** Replay speed at tau: SPEED, eased down to CASE_SPEED inside each case window. */
export function speedAt(P, tau) {
  let k = 0;
  for (const e of P.encounters) {
    const t = tau - e.tau;
    k = Math.max(k, smooth((t - (CASE.flyIn - 260)) / 240) * (1 - smooth((t - CASE.end) / 240)));
  }
  return SPEED + (CASE_SPEED - SPEED) * k;
}

/** Close-up weight (0 = horizon, 1 = zoomed on the encounter) at tau. */
export function caseWeight(enc, tau) {
  const t = tau - enc.tau;
  return smooth((t - CASE.flyIn) / (CASE.held - CASE.flyIn)) * (1 - smooth((t - CASE.out) / (CASE.end - CASE.out)));
}

/** Visibility of the other object around its encounter (fraction of its period; hides antipodal re-meetings). */
export function visibility(enc, tau) {
  const f = (tau - enc.tau) / Math.min(enc.orbit.period, enc.sat.orbit.period);
  return Math.max(0, Math.min(smooth((f + 0.4) / 0.05), 1 - smooth((f - 0.2) / 0.05)));
}

/** Basis label. Critical: "Pc-backed" or "distance only". Elevated: "Pc band", "distance", or both. */
export function basis(e) {
  const pc = e.latest.max_risk_estimate_log10, miss = e.latest.miss_distance_m;
  if (e.tier >= 2) return pcBacked(e) ? "Pc-backed" : "distance only";
  const byPc = pc != null && pc >= -6, byMiss = miss != null && miss <= 5000;
  return byPc && byMiss ? "Pc band + distance" : byPc ? "Pc band" : byMiss ? "distance" : "below both thresholds";
}

/** Background traffic: real below-threshold events; the other object's real elements, illustrative orientation. */
export function background(events) {
  return events.filter((e) => elems(e, "chaser")).map((e) => {
    const c = elems(e, "chaser"), id = e.event_id;
    const { P, Q } = planeBasis(c.inc_deg * deg, (id * 2.399963) % (2 * Math.PI), (id * 1.618) % (2 * Math.PI));
    const o = ellipse(c.sma_km / R_E, Math.min(0.95, c.ecc ?? 0), P, Q, (id * 0.7071) % (2 * Math.PI));
    return { id, event: e, orbit: o, type: ({ DEBRIS: "debris", PAYLOAD: "payload", "ROCKET BODY": "rocket_body" })[e.latest.object_type] || "unknown" };
  });
}
