// Horizon view: circular-orbit kinematics. Pure functions, no three.js, so the numbers can be checked on their own.
//
// Units: lengths in Earth radii (R_E = 6371 km = 1), angles in radians, `tau` = simulated orbital seconds.
// World axes follow three.js: +Y is the north pole, the equator is the XZ plane. Longitude is illustrative
// (the data has none); latitude, relative speed, miss distance and time-to-TCA order come from the events.

export const GM = 398600.4418; // km^3/s^2
export const R_E = 6371; // km
export const SPEED = 90; // one global time compression: simulated seconds per replay second
export const MISS_SCALE = 100; // miss distances drawn 100x so a 200 m pass is visible
export const INCLINATION = (97.4 * Math.PI) / 180; // a typical sun-synchronous LEO plane; reaches +-82.6 deg latitude
const RAAN = (35 * Math.PI) / 180; // illustrative
const MIN_GAP_S = 6; // replay seconds between closest approaches, so callouts never overlap
const FIRST_TCA_S = 6;

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => v3.mul(a, 1 / (v3.len(a) || 1)),
};

/** Mean motion (rad/s) and circular speed (km/s) at radius r (Earth radii). */
export const meanMotion = (r) => Math.sqrt(GM / (r * R_E) ** 3);
export const circularSpeed = (r) => Math.sqrt(GM / (r * R_E));

/** A circular orbit as a great circle: position(phase) = r (cos phase * e1 + sin phase * e2). */
function orbit(r, e1, e2, phase0) {
  const n = meanMotion(r);
  const normal = v3.cross(e1, e2);
  return {
    r, n, e1, e2, normal, phase0,
    period: (2 * Math.PI) / n,
    dirAt(phase) { return v3.add(v3.mul(e1, Math.cos(phase)), v3.mul(e2, Math.sin(phase))); },
    phase(tau) { return this.phase0 + n * tau; },
    pos(tau) { return v3.mul(this.dirAt(this.phase(tau)), r); },
    vel(tau) { const p = this.phase(tau); return v3.add(v3.mul(e1, -Math.sin(p)), v3.mul(e2, Math.cos(p))); },
  };
}

/** Our satellite: inclined plane, ascending node at RAAN. Argument of latitude u = phase. */
export function ownOrbit(r) {
  const node = [Math.cos(RAAN), 0, -Math.sin(RAAN)]; // on the equator
  const north = [0, 1, 0];
  const inPlaneEq = v3.cross(north, node); // equatorial, 90 deg ahead of the node
  const e2 = v3.add(v3.mul(inPlaneEq, Math.cos(INCLINATION)), v3.mul(north, Math.sin(INCLINATION)));
  return orbit(r, node, v3.norm(e2), 0);
}

/** Crossing angle from the real relative speed: v_rel = 2 v sin(theta / 2). Clamped so the planes stay distinct. */
export function crossingAngle(vRelMs, vKms) {
  const s = Math.min(1, Math.max(0, vRelMs / 1000 / (2 * vKms)));
  return Math.min((177 * Math.PI) / 180, Math.max((3 * Math.PI) / 180, 2 * Math.asin(s)));
}

const typeKey = (t) => ({ DEBRIS: "debris", PAYLOAD: "payload", "ROCKET BODY": "rocket_body" })[t] || "unknown";

/**
 * Build the encounter plan. Events must be sorted by time to TCA. For each one, our satellite flies on to the next
 * time it reaches the event's real latitude (ascending or descending pass), and the object's great circle is set to
 * cross that point at the same moment, at the real crossing angle, offset by the real miss vector (R and N parts of
 * the RTN miss, scaled). Returns everything in replay seconds.
 */
export function plan(events) {
  const bands = events.map((e) => e.latest.target_altitude_km).filter(Boolean).map(([a, b]) => (a + b) / 2);
  bands.sort((a, b) => a - b);
  const altKm = bands.length ? bands[Math.floor(bands.length / 2)] : 700;
  const r = 1 + altKm / R_E;
  const own = ownOrbit(r);
  const v = circularSpeed(r);
  const maxLat = Math.PI / 2 - Math.abs(Math.PI / 2 - INCLINATION);
  const gap = own.n * SPEED * MIN_GAP_S;

  let u = -Infinity;
  const raw = events.map((e, idx) => {
    const L = e.latest;
    const latDeg = L.geocentric_latitude_deg ?? 0;
    const lat = Math.max(-maxLat, Math.min(maxLat, (latDeg * Math.PI) / 180));
    const a = Math.asin(Math.sin(lat) / Math.sin(INCLINATION));
    const base = idx === 0 ? -Infinity : u + gap;
    let best = Infinity;
    for (let k = -1; k < 8; k++) {
      for (const c of [a, Math.PI - a]) {
        const cand = c + 2 * Math.PI * k;
        if (cand >= (idx === 0 ? 0 : base) && cand < best) best = cand;
      }
    }
    u = best;
    return { e, u, latDeg, latClamped: Math.abs(latDeg * Math.PI / 180) > maxLat };
  });

  // Shift time so the first closest approach lands at FIRST_TCA_S.
  const tau0 = raw[0].u / own.n - FIRST_TCA_S * SPEED;
  const tauOf = (uu) => uu / own.n - tau0;
  const ownShifted = orbit(r, own.e1, own.e2, own.n * tau0);

  const encounters = raw.map(({ e, u: uj, latDeg, latClamped }, idx) => {
    const L = e.latest;
    const tauJ = tauOf(uj);
    const X = ownShifted.dirAt(uj); // unit, crossing direction
    const t = ownShifted.vel(tauJ); // along-track unit
    const h = ownShifted.normal; // orbit normal (N)
    const theta = crossingAngle(L.relative_speed_ms ?? 14000, v);
    // Alternate the side the object crosses from, so arcs fan out instead of stacking.
    const side = idx % 2 ? 1 : -1;
    const vdir = v3.add(v3.mul(t, Math.cos(theta)), v3.mul(h, side * Math.sin(theta)));
    // Miss vector from the RTN components (T is ~0 at TCA): radial and cross-track, scaled to the real miss distance.
    const [mr, , mn] = L.relative_position_rtn_m || [1, 0, 0];
    // Keep it perpendicular to the relative velocity, so the closest approach falls exactly at the TCA.
    const rel = v3.norm(v3.sub(vdir, t));
    let dir = v3.add(v3.mul(X, mr || 0), v3.mul(h, mn || 0));
    dir = v3.sub(dir, v3.mul(rel, v3.dot(dir, rel)));
    dir = v3.len(dir) > 1e-9 ? v3.norm(dir) : X;
    const offKm = (L.miss_distance_m * MISS_SCALE) / 1000;
    const Xp = v3.add(v3.mul(X, r), v3.mul(dir, offKm / R_E));
    const rj = v3.len(Xp);
    const e1 = v3.norm(Xp);
    const e2 = v3.norm(v3.sub(vdir, v3.mul(e1, v3.dot(vdir, e1)))); // perpendicular to e1, in the travel direction
    const obj = orbit(rj, e1, e2, 0);
    obj.phase0 = -obj.n * tauJ; // at tau_j the object is at its crossing point
    return {
      id: e.event_id, event: e, type: typeKey(L.object_type), tier: e.tier,
      tcaS: tauJ / SPEED, tau: tauJ, latDeg, latClamped,
      thetaDeg: (theta * 180) / Math.PI, orbit: obj,
    };
  });

  const endS = encounters[encounters.length - 1].tcaS + 8;
  return { r, altKm, own: ownShifted, encounters, endS, speed: SPEED, missScale: MISS_SCALE };
}

/** Visibility window around each object's encounter, as a fraction of its period. Hides the antipodal re-meetings
 *  that two equal-radius circular orbits have every half period (they are not events in the data). */
export function visibility(enc, tau) {
  const f = (tau - enc.tau) / enc.orbit.period;
  const fadeIn = smooth((f + 0.42) / 0.05);
  const fadeOut = 1 - smooth((f - 0.2) / 0.05);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** Pc-backed: the Pc upper bound on its own reaches the event's tier (>= 1e-4 Critical, >= 1e-6 Elevated). */
export function basis(e) {
  const pc = e.latest.max_risk_estimate_log10;
  const bar = e.tier >= 2 ? -4 : -6;
  return pc != null && pc >= bar ? "Pc-backed" : "distance only";
}
