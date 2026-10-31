// Horizon v2: one three.js scene. Our satellites (one per mission) and each case's other object fly on Keplerian
// orbits from the CDMs' real orbital elements; each classification case zooms in on the real CDM approach geometry
// (R/T/N per update), then shows the decision and backend trace in one docked panel. Orbits and replay timing:
// horizon-orbits.js. Data: GET /api/events, /api/events/{id} (history + certificate), /api/audit (docs/CONTRACT.md).
import { plan, pickCases, background, speedAt, caseWeight, visibility, basis, smooth, CASE, SPEED, CASE_SPEED, R_E } from "./horizon-orbits.js";

const THREE = window.THREE;
const BG_COUNT = 40;
const COL = { bg: 0x080a0b, own: 0x5ea9ff, grey: 0x9ba5a1, crit: 0xff4a3d, elev: 0xe8a33c, below: 0x8a9490 };
const TIER_HEX = [COL.below, COL.elev, COL.crit];
const TIER_NAME = ["Below threshold", "Elevated", "Critical"];
const TIER_CLASS = ["m", "e", "c"];
const TIER_VAR = ["var(--below)", "var(--elev)", "var(--crit)"];
const SIGMA_SENTINEL_M = 1e7; // the dataset's ~63,781 km placeholder for an unusable sigma
const PING_TAU = 45; // simulated seconds a detection ping takes to expand
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hash = new URLSearchParams(location.hash.slice(1));

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDist = (m) => (m < 10_000 ? `${Math.round(m).toLocaleString("en")} m` : `${(m / 1000).toFixed(1)} km`);
const fmtPc = (l) => (l == null ? "n/a" : `1e${l.toFixed(1)}`);
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const typeLabel = (t) => ({ rocket_body: "rocket body" })[t] || t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// ---------- backend trace (from the latest certificate) ----------
let audit = null;
fetch("/api/audit").then((r) => (r.ok ? r.json() : null)).then((a) => { audit = a || { status: "unavailable" }; })
  .catch(() => { audit = { status: "unavailable" }; });
const shortReason = (r) => r
  .replace(/^miss distance (.+?) < 1 km$/, "miss $1 < 1 km")
  .replace(/^miss distance (.+?) km within 1-5 km$/, "miss $1 km in 1–5 km")
  .replace(/^Pc 10\^(-?[\d.]+) >= 1e-4.*$/, "Pc 10^$1 ≥ 1e-4")
  .replace(/^Pc 10\^(-?[\d.]+) in \[1e-6, 1e-4\).*$/, "Pc 10^$1 (elevated band)");
const WHY_NOT = { Critical: "rule-defined Critical" };
const CHECK = `<svg class="ok" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.3 2.3 4.7-5.3"/></svg>`;
function traceSteps(e) {
  const c = e.certificate, queue = titleCase(e.action && e.action.queue);
  const steps = [["Rule fired", esc((e.reasons || []).map(shortReason).join(" · ") || "none")]];
  if (!c) steps.push(["Model allowed?", `<span class="m">no certificate in this report</span>`]);
  else {
    steps.push(["Model allowed?", c.candidate ? "Yes: demotion candidate" : `No: ${esc(WHY_NOT[c.why_not_candidate] || c.why_not_candidate || "not eligible")}`]);
    if (c.candidate && c.model_score != null && c.threshold != null) {
      steps.push(["Score vs threshold", `${c.model_score.toFixed(4)} ${c.model_score < c.threshold ? "<" : "≥"} ${c.threshold.toFixed(4)}`]);
    }
    steps.push(["Decision", `${esc(c.decision)} → ${esc(queue)}`]);
  }
  steps.push(["Guardrails", !audit ? `<span class="m">checking…</span>` : audit.status === "PASS"
    ? `${CHECK} audit PASS <span class="m">(${(audit.checks || []).length} checks)</span>` : `<span class="m">audit ${esc(audit.status)}</span>`]);
  return steps;
}

async function main() {
  let list, icons;
  try {
    const [res, ic] = await Promise.all([fetch("/api/events"), fetch("/static/icons.json")]);
    if (!res.ok) throw new Error(`/api/events ${res.status}`);
    list = (await res.json()).events;
    icons = ic.ok ? await ic.json() : null;
    if (!list.some((e) => e.latest && e.latest.orbit)) throw new Error("events.json has no orbital elements (rebuild with triage.build_events)");
  } catch (err) { return showError(err); }
  const picked = pickCases(list);
  if (!picked.length) return showError(new Error("no classification cases found"));
  // the case events with their full CDM history
  const cases = await Promise.all(picked.map(async (c) => {
    const r = await fetch(`/api/events/${c.event.event_id}`);
    return { ...c, event: r.ok ? await r.json() : c.event };
  }));
  const below = list.filter((e) => e.tier === 0 && e.latest && !cases.some((c) => c.event.event_id === e.event_id))
    .sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days).slice(0, BG_COUNT);
  start(plan(cases, list), icons, background(below));
}

function showError(err) {
  $("#scene").remove();
  const el = document.createElement("div");
  el.className = "load-error";
  el.innerHTML = `<p><b>Couldn't load the events.</b><br>${esc(err.message)}<br>Start the API with <span class="num">uv run uvicorn server:app</span> and reload.</p>`;
  document.body.append(el);
}

function start(P, icons, bg) {
  THREE.ColorManagement.enabled = false;
  const canvas = $("#scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(COL.bg, 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.00002, 400);
  const keyView = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();
  const keyWorld = new THREE.Vector3();
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  scene.add(key, key.target);
  const first = P.encounters[0];
  const sunWorld = V(first.sat.orbit.pos(first.tau)).normalize().addScaledVector(V(first.sat.orbit.normal), -0.6).normalize();

  // ---------- Earth, atmosphere, stars ----------
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uLight: { value: keyView }, uSun: { value: sunWorld }, uMinor: { value: 1 },
      uBase: { value: new THREE.Color(0x0a100f) }, uLine: { value: new THREE.Color(0x2b3c37) },
      uRim: { value: new THREE.Color(0x1f4f80) }, uHaze: { value: new THREE.Color(0x3b78b8) },
    },
    vertexShader: `varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      void main() { vObj = normal; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uLight; uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uRim; uniform float uMinor; uniform vec3 uSun; uniform vec3 uHaze;
      varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN); vec3 Vd = normalize(vV);
        float lat = degrees(asin(clamp(normalize(vObj).y, -1.0, 1.0)));
        float w = max(fwidth(lat), 1e-4);
        float d10 = abs(fract(lat / 10.0 + 0.5) - 0.5) * 10.0, d30 = abs(fract(lat / 30.0 + 0.5) - 0.5) * 30.0;
        float lines = (0.45 * uMinor * (1.0 - smoothstep(0.0, w * 1.1, d10)) + 0.8 * (1.0 - smoothstep(0.0, w * 1.4, d30))) * (1.0 - smoothstep(0.6, 3.5, w));
        float diff = max(dot(N, uLight), 0.0);
        float day = smoothstep(-0.12, 0.3, dot(normalize(vObj), uSun));
        float edge = 1.0 - max(dot(N, Vd), 0.0);
        vec3 col = uBase * (0.55 + 0.35 * diff + 0.75 * day) + uLine * lines * (0.4 + 0.3 * diff + 0.3 * day)
                 + uRim * pow(edge, 5.0) * (0.12 + 0.6 * day) + uHaze * pow(edge, 2.4) * day * 0.16;
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 192, 144), earthMat));
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uSun: { value: sunWorld }, uColor: { value: new THREE.Color(0x4a8fd6) } },
    vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uCam; uniform vec3 uSun; uniform vec3 uColor; varying vec3 vW;
      void main() {
        vec3 d = normalize(vW - uCam); float tca = max(-dot(uCam, d), 0.0); vec3 tp = uCam + d * tca;
        float h = length(tp) - 1.0; float g = h > 0.0 ? exp(-h / 0.008) : 0.0;
        float lit = 0.22 + 0.78 * smoothstep(-0.2, 0.4, dot(normalize(tp), uSun));
        vec3 c = uColor * g * lit * 0.8 + (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * g;
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 160, 120), atmoMat));
  {
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      pos.set([Math.cos(a) * s * 300, z * 300, Math.sin(a) * s * 300], i * 3);
      const b = 0.18 + rnd() ** 3 * 0.55; col.set([b, b, b * 1.04], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
  }

  // ---------- helpers: orbit lines, trails, models ----------
  const ellipseLine = (o, hex, opacity, n = 360) => {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(V(o.atNu((i / n) * Math.PI * 2)));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false }));
    scene.add(l); return l;
  };
  const makeTrail = (hex, n, span) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const c = new Float32Array(n * 3), base = new THREE.Color(hex);
    for (let i = 0; i < n; i++) { const f = (1 - i / (n - 1)) ** 1.6; c.set([base.r * f, base.g * f, base.b * f], i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false; line.userData = { n, span }; scene.add(line); return line;
  };
  const updateTrail = (line, o, tau, alpha, off) => {
    const a = line.geometry.attributes.position, { n, span } = line.userData, dt = (o.period * span) / n;
    for (let i = 0; i < n; i++) { const p = o.pos(tau - i * dt); a.setXYZ(i, p[0] + (i === 0 && off ? off.x : 0), p[1] + (i === 0 && off ? off.y : 0), p[2] + (i === 0 && off ? off.z : 0)); }
    a.needsUpdate = true; line.material.opacity = alpha; line.visible = alpha > 0.01;
  };
  const geomCache = {};
  const geomFor = (name) => {
    if (geomCache[name]) return geomCache[name];
    const m = icons && (icons[name] || icons.unknown);
    let g;
    if (m) {
      g = new THREE.BufferGeometry();
      const p = new Float32Array(m.x.length * 3);
      m.x.forEach((_, i) => p.set([m.x[i], m.y[i], m.z[i]], i * 3));
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      const idx = []; m.i.forEach((_, t) => idx.push(m.i[t], m.j[t], m.k[t]));
      g.setIndex(idx); g = g.toNonIndexed(); g.computeVertexNormals();
    } else g = new THREE.OctahedronGeometry(0.5);
    return (geomCache[name] = g);
  };
  const modelMat = (hex) => new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: 0.65, metalness: 0.1, transparent: true, side: THREE.DoubleSide });
  const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4() };
  function placeModel(mesh, pos, vel, size, type, spin) {
    const zU = tmp.a.copy(pos).normalize(), xT = tmp.b.copy(vel).normalize(), yN = tmp.c.crossVectors(zU, xT).normalize();
    if (type === "rocket_body") mesh.matrix.makeBasis(zU, yN, xT); else mesh.matrix.makeBasis(xT, yN, zU);
    if (spin) mesh.matrix.multiply(tmp.m.makeRotationFromEuler(new THREE.Euler(spin * 0.7, spin, spin * 0.4)));
    mesh.matrix.scale(new THREE.Vector3(size, size, size)).setPosition(pos);
    mesh.matrixWorldNeedsUpdate = true;
  }
  const ringTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d"); x.strokeStyle = "#fff"; x.lineWidth = 5; x.beginPath(); x.arc(64, 64, 56, 0, Math.PI * 2); x.stroke();
    return new THREE.CanvasTexture(c);
  })();

  // ---------- our satellites ----------
  const labelsEl = $("#labels");
  const sats = P.sats.map((s) => {
    const mesh = new THREE.Mesh(geomFor("own_satellite"), modelMat(COL.own));
    mesh.matrixAutoUpdate = false; scene.add(mesh);
    const label = document.createElement("div");
    label.className = "sat-label"; label.textContent = `Sat M${s.id} · ${Math.round(s.altKm)} km`; labelsEl.append(label);
    return { s, mesh, label, ring: ellipseLine(s.orbit, COL.own, 0.22), trail: makeTrail(COL.own, 60, 0.06), pos: new THREE.Vector3() };
  });
  const satOf = new Map(sats.map((x) => [x.s.id, x]));

  // ---------- the cases' other objects ----------
  const objs = P.encounters.map((enc) => {
    const mesh = new THREE.Mesh(geomFor(enc.type), modelMat(COL.grey));
    mesh.matrixAutoUpdate = false; scene.add(mesh);
    const flag = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: TIER_HEX[enc.event.tier], transparent: true, depthWrite: false, sizeAttenuation: false }));
    flag.visible = false; scene.add(flag);
    return { enc, mesh, flag, ring: ellipseLine(enc.orbit, 0x5d6965, 0), trail: makeTrail(0x8d9692, 30, 0.035), pos: new THREE.Vector3() };
  });

  // ---------- background: real below-threshold events, dim specks with short trails ----------
  const BG_TRAIL = 8;
  const bgPos = new Float32Array(bg.length * 3), bgWorld = bg.map(() => new THREE.Vector3());
  const bgGeom = new THREE.BufferGeometry(); bgGeom.setAttribute("position", new THREE.BufferAttribute(bgPos, 3));
  const bgMat = new THREE.PointsMaterial({ color: 0x8a9490, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.65, depthWrite: false });
  const bgPoints = new THREE.Points(bgGeom, bgMat); bgPoints.frustumCulled = false; scene.add(bgPoints);
  const bgTrailPos = new Float32Array(bg.length * (BG_TRAIL - 1) * 6), bgTrailCol = new Float32Array(bgTrailPos.length);
  for (let j = 0; j < bg.length; j++) for (let i = 0; i < BG_TRAIL - 1; i++) {
    const f0 = (1 - i / (BG_TRAIL - 1)) ** 1.5 * 0.3, f1 = (1 - (i + 1) / (BG_TRAIL - 1)) ** 1.5 * 0.3;
    bgTrailCol.set([f0 * .54, f0 * .58, f0 * .56, f1 * .54, f1 * .58, f1 * .56], (j * (BG_TRAIL - 1) + i) * 6);
  }
  const bgTrailGeom = new THREE.BufferGeometry();
  bgTrailGeom.setAttribute("position", new THREE.BufferAttribute(bgTrailPos, 3)); bgTrailGeom.setAttribute("color", new THREE.BufferAttribute(bgTrailCol, 3));
  const bgTrails = new THREE.LineSegments(bgTrailGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  bgTrails.frustumCulled = false; scene.add(bgTrails);
  function updateBackground(tau) {
    bg.forEach((b, j) => {
      const o = b.orbit, dt = o.period * 0.004;
      let prev = o.pos(tau);
      bgPos.set(prev, j * 3); bgWorld[j].set(prev[0], prev[1], prev[2]);
      for (let i = 0; i < BG_TRAIL - 1; i++) {
        const p = o.pos(tau - (i + 1) * dt);
        bgTrailPos.set([...prev, ...p], (j * (BG_TRAIL - 1) + i) * 6); prev = p;
      }
    });
    bgGeom.attributes.position.needsUpdate = true; bgTrailGeom.attributes.position.needsUpdate = true;
  }

  // ---------- close-up: the real CDM approach geometry in our satellite's R/T/N frame, in km ----------
  // Group axes: x = T (along-track), y = R (radial), z = -N; children in km (group scale 1 / R_E).
  const rtn = new THREE.Group(); rtn.matrixAutoUpdate = false; scene.add(rtn);
  const circle = (radiusKm, hex, opacity, dashed) => {
    const pts = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radiusKm, Math.sin(a) * radiusKm, 0)); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = dashed ? new THREE.LineDashedMaterial({ color: hex, transparent: true, opacity, dashSize: radiusKm * 0.06, gapSize: radiusKm * 0.05, depthWrite: false })
      : new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false });
    const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); rtn.add(l); return l;
  };
  const shell5 = circle(5, COL.elev, 0.3, true), shell1 = circle(1, COL.crit, 0.3, false);
  const ping = circle(1, COL.elev, 0); ping.visible = false;
  const MAXC = 32;
  const dotGeom = new THREE.BufferGeometry();
  dotGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXC * 3), 3));
  dotGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAXC * 3), 3));
  const dots = new THREE.Points(dotGeom, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
  dots.frustumCulled = false; rtn.add(dots);
  const pathGeom = new THREE.BufferGeometry(); pathGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXC * 3), 3));
  const path = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({ color: 0x6f7b77, transparent: true, opacity: 0.5, depthWrite: false }));
  path.frustumCulled = false; rtn.add(path);
  const sigmaGeom = new THREE.BufferGeometry(); sigmaGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  const sigmaBar = new THREE.LineSegments(sigmaGeom, new THREE.LineBasicMaterial({ color: 0xe6ebe8, transparent: true, opacity: 0.7, depthWrite: false }));
  sigmaBar.frustumCulled = false; rtn.add(sigmaBar);
  const closeObj = new THREE.Mesh(geomFor("debris"), modelMat(COL.grey)); closeObj.matrixAutoUpdate = true; rtn.add(closeObj);
  const closeOwn = new THREE.Mesh(geomFor("own_satellite"), modelMat(COL.own)); rtn.add(closeOwn);
  // illustrative manoeuvre (Pc-backed Critical): ghost of the nominal path and the bent path, in the R/T plane
  const ghost = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-40, 0, 0), new THREE.Vector3(40, 0, 0)]),
    new THREE.LineDashedMaterial({ color: 0x7d8a85, transparent: true, opacity: 0.6, dashSize: 0.5, gapSize: 0.4, depthWrite: false }));
  ghost.computeLineDistances(); rtn.add(ghost);
  const bentGeom = new THREE.BufferGeometry(); bentGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(121 * 3), 3));
  const bent = new THREE.Line(bentGeom, new THREE.LineBasicMaterial({ color: COL.own, transparent: true, opacity: 0.9, depthWrite: false }));
  bent.frustumCulled = false; rtn.add(bent);
  const ringLabels = [5, 1].map((km) => { const d = document.createElement("div"); d.className = "ring-label"; d.textContent = `${km} km`; labelsEl.append(d); return { km, d }; });
  const MAN_KM = 2; // illustrative avoidance offset at TCA

  // per-case frame size: fit the CDM history (km), never smaller than the 5 km shell
  for (const enc of P.encounters) {
    const ext = Math.max(6, ...enc.cdms.map((h) => Math.max(Math.abs(h.relative_position_rtn_m[0]), Math.abs(h.relative_position_rtn_m[1])) / 1000));
    enc.frameKm = Math.min(60, ext * 1.25);
  }

  // ---------- time + controls ----------
  const slider = $("#time"), playBtn = $("#play"), readout = $("#readout");
  slider.max = String(Math.round(P.endTau));
  $("#ticks").innerHTML = P.encounters.map((e) => `<span style="left:${((e.tau / P.endTau) * 100).toFixed(2)}%;--c:${TIER_VAR[e.event.tier]}" title="EVT ${e.id}"></span>`).join("");
  $("#scale").innerHTML = `×${SPEED} cruise · ×${CASE_SPEED} in a case · models not to scale<br>Close-up shells: 1 km, 5 km (to scale)`;
  let tau = 0, playing = !reduced;
  const byId = new Map(P.encounters.map((e) => [e.id, e]));
  const demo = byId.get(Number(hash.get("demo"))), pingCase = byId.get(Number(hash.get("ping")));
  if (demo) { tau = demo.tau - 60; playing = false; }
  else if (pingCase && pingCase.cdms.length) { const c = pingCase.cdms[Math.floor(pingCase.cdms.length / 2)]; tau = c.tau + 14; playing = false; }
  else if (hash.has("t")) tau = clamp(Number(hash.get("t")) || 0, 0, P.endTau);
  else if (reduced) tau = P.encounters[0].tau - 60;
  if (hash.has("pause")) playing = false;
  const setPlaying = (p) => { playing = p; playBtn.setAttribute("aria-pressed", String(p)); playBtn.setAttribute("aria-label", p ? "Pause replay" : "Play replay"); };
  setPlaying(playing);
  playBtn.addEventListener("click", () => { if (!playing && tau >= P.endTau - 1) tau = 0; setPlaying(!playing); });
  slider.addEventListener("input", () => { tau = Number(slider.value); });
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLAnchorElement)) { e.preventDefault(); setPlaying(!playing); }
  });
  const caseIndexAt = (t) => { const i = P.encounters.findIndex((e) => t < e.tau + CASE.end); return i < 0 ? P.encounters.length - 1 : i; };
  const jumpCase = (d) => {
    const i = clamp(caseIndexAt(tau) + d, 0, P.encounters.length - 1);
    tau = Math.max(0, P.encounters[i].tau + CASE.flyIn - 150);
    zoomTarget = 0; yaw = 0; pitch = 0; syncViewBtns();
    if (!reduced) setPlaying(true);
  };
  $("#case-prev").addEventListener("click", () => jumpCase(tau > P.encounters[caseIndexAt(tau)].tau + CASE.flyIn ? 0 : -1));
  $("#case-next").addEventListener("click", () => jumpCase(1));

  let zoom = hash.get("view") === "globe" ? 1 : 0, zoomTarget = zoom, yaw = 0, pitch = 0;
  const viewBtns = [...document.querySelectorAll(".views button")];
  const syncViewBtns = () => viewBtns.forEach((b) => b.setAttribute("aria-pressed", String((zoomTarget >= 0.5 ? 1 : 0) === Number(b.dataset.view))));
  viewBtns.forEach((b) => b.addEventListener("click", () => { zoomTarget = Number(b.dataset.view); yaw *= 0.3; pitch *= 0.3; syncViewBtns(); }));
  syncViewBtns();
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomTarget = clamp(zoomTarget + e.deltaY * 0.0011, 0, 1); syncViewBtns(); }, { passive: false });
  const pointers = new Map(); let pinch0 = 0, mouse = null;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); canvas.classList.add("dragging"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) { mouse = [e.clientX, e.clientY]; return; }
    mouse = null;
    const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0) { zoomTarget = clamp(zoomTarget - Math.log(d / pinch0) * 0.9, 0, 1); syncViewBtns(); }
      pinch0 = d; return;
    }
    const lim = lerp(0.55, 1.3, zoom);
    yaw = clamp(yaw - ((e.clientX - px) / innerWidth) * 2.2, -lim, lim);
    pitch = clamp(pitch + ((e.clientY - py) / innerHeight) * 1.6, -lim * 0.5, lim * 0.5);
  });
  const up = (e) => { pointers.delete(e.pointerId); pinch0 = 0; if (!pointers.size) canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { mouse = null; });

  // ---------- camera: horizon chase of the focus satellite <-> globe, then the case close-up on top ----------
  function chasePose(sat, t) {
    const o = sat.s.orbit, p = V(o.pos(t)), U = p.clone().normalize(), T = V(o.vel(t));
    const h = V(o.normal);
    const camH = p.clone().addScaledVector(U, 0.028).addScaledVector(h, -0.12).addScaledVector(T, -0.075);
    const tgtH = p.clone().addScaledVector(T, 0.06).addScaledVector(U, -0.03);
    const globeDir = h.clone().multiplyScalar(-0.62).addScaledVector(U, 0.7).add(new THREE.Vector3(0, 0.2, 0)).normalize();
    const z = ease(zoom), rH = camH.length(), rG = 6.2;
    const dir = camH.clone().normalize(), ang = dir.angleTo(globeDir), axis = new THREE.Vector3().crossVectors(dir, globeDir).normalize();
    if (ang > 1e-4 && axis.lengthSq() > 0) dir.applyAxisAngle(axis, ang * z);
    return { pos: dir.multiplyScalar(Math.exp(lerp(Math.log(rH), Math.log(rG), z))), tgt: tgtH.multiplyScalar(1 - ease(Math.min(1, zoom * 1.25))), up: U.lerp(new THREE.Vector3(0, 1, 0), z).normalize() };
  }
  function closePose(enc, t) {
    const o = enc.sat.orbit, S = V(o.pos(t)), R = S.clone().normalize(), T = V(o.vel(t)), N = new THREE.Vector3().crossVectors(R, T).normalize();
    const d = (enc.frameKm * 3.2) / R_E;
    return { pos: S.clone().addScaledVector(N, -d).addScaledVector(R, d * 0.26), tgt: S.clone().addScaledVector(T, d * 0.2), up: R };
  }
  const blendPose = (a, b, w) => ({ pos: a.pos.clone().lerp(b.pos, w), tgt: a.tgt.clone().lerp(b.tgt, w), up: a.up.clone().lerp(b.up, w).normalize() });
  let focus = null, prevFocus = null, focusSince = -1e9;

  // ---------- docked case panel (text never moves; blocks cross-fade when their content changes) ----------
  const blocks = { head: $("#case-head"), title: $("#b-title"), cdm: $("#b-cdm"), cls: $("#b-class"), trace: $("#b-trace") };
  const lastHtml = {};
  const setBlock = (k, html) => {
    if (lastHtml[k] === html) return;
    lastHtml[k] = html; const el = blocks[k]; el.innerHTML = html;
    if (!reduced && k !== "head") { el.classList.remove("fade"); void el.offsetWidth; el.classList.add("fade"); }
  };
  const traceBtn = $("#trace-toggle");
  let traceOn = true;
  try { traceOn = localStorage.getItem("horizon.trace") !== "off"; } catch { /* storage blocked: default on */ }
  traceBtn.setAttribute("aria-pressed", String(traceOn));
  traceBtn.addEventListener("click", () => {
    traceOn = !traceOn; traceBtn.setAttribute("aria-pressed", String(traceOn));
    try { localStorage.setItem("horizon.trace", traceOn ? "on" : "off"); } catch { /* ignore */ }
    blocks.trace.style.display = traceOn ? "" : "none";
  });
  blocks.trace.style.display = traceOn ? "" : "none";
  let traceFor = null, traceTimers = [];
  function caseNote(enc) {
    const e = enc.event, c = e.certificate || {};
    const sc = c.model_score != null && c.threshold != null ? `${c.model_score.toFixed(4)} ${c.model_score < c.threshold ? "<" : "≥"} ${c.threshold.toFixed(4)}` : null;
    switch (enc.kind.key) {
      case "dist": return `Pc doesn't back a manoeuvre → analyst review`;
      case "pc": return `Illustrative avoidance manoeuvre shown <span class="m">(operator-approved; never commanded by Second Look)</span>`;
      case "kept": return sc ? `Model kept Elevated: score ${sc}` : "Model kept Elevated";
      case "demoted": return sc ? `Model demoted: score ${sc} → below threshold` : "Model demoted: score < threshold";
      case "watch": { const r = (e.action?.reasons || []).find((x) => /watch|clos|threshold/i.test(x)); return `Escalation watch${r ? `: <span class="m">${esc(r)}</span>` : ""}`; }
      default: return "";
    }
  }
  function updatePanel(enc, t, w) {
    const i = P.encounters.indexOf(enc), e = enc.event, L = e.latest;
    setBlock("head", `<span>Case <b>${i + 1}/${P.encounters.length}</b></span><span>${esc(enc.kind.label)}</span>`);
    const inCase = t >= enc.tau + CASE.flyIn - 200;
    if (!inCase) {
      const mins = Math.max(0, Math.round((enc.tau + CASE.flyIn - t) / 60));
      setBlock("title", `<div class="t1">Next case in ${mins} min</div><div class="t2">EVT ${e.event_id} · Sat M${enc.sat.id} · ${esc(typeLabel(enc.type))}</div>`);
      setBlock("cdm", `<div class="sub">Detections fire only on real CDM updates (${enc.cdms.length} for this event).</div>`);
      setBlock("cls", ""); setBlock("trace", ""); traceFor = null; return;
    }
    setBlock("title", `<div class="t1">EVT ${e.event_id} · ${esc(typeLabel(enc.type))}</div><div class="t2">Sat M${enc.sat.id} · crossing at ${enc.latDeg.toFixed(1)}° · ${(L.relative_speed_ms / 1000).toFixed(1)} km/s · TCA ${L.time_to_tca_days.toFixed(2)} d</div>`);
    const seen = enc.cdms.filter((c) => c.tau <= t), cur = seen[seen.length - 1];
    const ticks = `<div class="ticks-row">${enc.cdms.map((c) => `<i class="${c.tau <= t ? `t${c.pred_tier}` : ""}"></i>`).join("")}</div>`;
    setBlock("cdm", cur
      ? `<div class="cdm-line"><span class="n">CDM ${cur.n}/${cur.N}</span> · EVT ${e.event_id} · miss ${fmtDist(cur.miss_distance_m)} · Pc ≤ ${fmtPc(cur.max_risk_estimate_log10)} · <span style="color:${TIER_VAR[cur.pred_tier]}">${TIER_NAME[cur.pred_tier]}</span></div>${ticks}
         <div class="sub">T−${cur.time_to_tca_days.toFixed(2)} d · ${sigmaText(cur)}</div>`
      : `<div class="cdm-line n">Screening… waiting for the first CDM</div>${ticks}`);
    const done = seen.length === enc.cdms.length && enc.cdms.length > 0;
    if (!done) { setBlock("cls", ""); setBlock("trace", ""); traceFor = null; return; }
    setBlock("cls", `<div class="cls" style="--c:${TIER_VAR[e.tier]}"><span class="tier">${TIER_NAME[e.tier]}</span> (${esc(titleCase(e.action?.queue))}) · ${basis(e)}</div>
      <div class="note">${caseNote(enc)}</div><a href="/static/review.html#event=${e.event_id}">Open decision record</a>`);
    if (traceFor !== enc) {
      traceFor = enc; traceTimers.forEach(clearTimeout); traceTimers = [];
      const steps = traceSteps(e);
      setBlock("trace", `<div class="th">Backend trace</div><ol class="trace" aria-label="Backend trace">${steps.map(([k, v], j) =>
        `<li class="${reduced ? "on" : ""}"><span class="n">${j + 1}</span><span class="k">${k}</span><span class="v">${v}</span></li>`).join("")}</ol>`);
      if (!reduced) [...blocks.trace.querySelectorAll("li")].forEach((li, j) => traceTimers.push(setTimeout(() => li.classList.add("on"), 150 + j * 250)));
    } else if (audit && /checking/.test(lastHtml.trace || "")) {
      const last = blocks.trace.querySelector("li:last-child .v"); if (last) last.innerHTML = traceSteps(e).at(-1)[1];
    }
  }
  const sigmaText = (h) => {
    const s = h.sigma_r_m || {};
    if (!(s.chaser < SIGMA_SENTINEL_M && s.target < SIGMA_SENTINEL_M)) return "no usable radial uncertainty (placeholder sigma)";
    return `radial σ ±${fmtDist(Math.hypot(s.chaser, s.target))}`;
  };

  // ---------- hover tooltips (only on hover; no labels follow debris) ----------
  const tip = $("#tip"), countsEl = $("#counts"), leader = $("#leader line"), manoeuvreEl = $("#manoeuvre");
  const isOccluded = (pos) => { const d = tmp.b.copy(pos).sub(camera.position); const k = clamp(-camera.position.dot(d) / d.lengthSq(), 0, 1); return tmp.c.copy(camera.position).addScaledVector(d, k).length() < 1; };
  const toScreen = (pos) => {
    const p = tmp.a.copy(pos).project(camera);
    if (p.z >= 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05 || isOccluded(pos)) return null;
    return [(p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight];
  };
  function updateHover() {
    if (!mouse) { tip.hidden = true; return; }
    let best = null, bd = 14 * 14;
    const consider = (pos, html) => { const sp = toScreen(pos); if (!sp) return; const d = (sp[0] - mouse[0]) ** 2 + (sp[1] - mouse[1]) ** 2; if (d < bd) { bd = d; best = html; } };
    bg.forEach((b, j) => consider(bgWorld[j], `EVT ${b.id} <span class="m">· ${esc(typeLabel(b.type))} · below threshold</span>`));
    for (const o of objs) if (o.mesh.visible) consider(o.pos, `EVT ${o.enc.id} <span class="m">· ${esc(typeLabel(o.enc.type))} ·</span> <span class="${TIER_CLASS[o.enc.event.tier]}">${TIER_NAME[o.enc.event.tier]}</span>`);
    for (const s of sats) consider(s.pos, `<span class="o">Sat M${s.s.id}</span> <span class="m">· ${Math.round(s.s.altKm)} km · a ${Math.round(s.s.smaKm)} km · i ${s.s.incDeg.toFixed(1)}°</span>`);
    tip.hidden = !best;
    if (best) { tip.innerHTML = best; tip.style.transform = `translate(${Math.round(Math.min(mouse[0] + 14, innerWidth - tip.offsetWidth - 8))}px, ${Math.round(Math.max(8, mouse[1] - 30))}px)`; }
  }
  let countsKey = "";

  function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener("resize", resize); resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (playing) { tau += dt * speedAt(P, tau); if (tau > P.endTau) tau = 0; }
    if (document.activeElement !== slider) slider.value = String(Math.round(tau));
    readout.innerHTML = `<b>+${Math.round(tau / 60)}</b> MIN · ×${Math.round(speedAt(P, tau))}`;
    zoom = reduced ? zoomTarget : zoom + (zoomTarget - zoom) * (1 - Math.exp(-dt * 3));
    if (Math.abs(zoom - zoomTarget) < 1e-3) zoom = zoomTarget;

    // the case in play: the one whose window contains tau, else the next one
    const enc = P.encounters[caseIndexAt(tau)];
    const w = caseWeight(enc, tau);
    const fsat = satOf.get(enc.sat.id);
    if (fsat !== focus) { prevFocus = focus; focus = fsat; focusSince = now; }
    const fk = reduced || !prevFocus ? 1 : smooth((now - focusSince) / 1600);
    let pose = chasePose(focus, tau);
    if (fk < 1) pose = blendPose(chasePose(prevFocus, tau), pose, ease(fk));
    if (w > 0) pose = blendPose(pose, closePose(enc, tau), ease(w));
    // drag offset
    const off = pose.pos.clone().sub(pose.tgt);
    off.applyAxisAngle(pose.up, yaw); off.applyAxisAngle(new THREE.Vector3().crossVectors(off, pose.up).normalize(), pitch);
    const cp = pose.tgt.clone().add(off);
    if (cp.length() < 1.0005) cp.setLength(1.0005);
    camera.position.copy(cp); camera.up.copy(pose.up); camera.lookAt(pose.tgt);
    camera.fov = lerp(42, 30, ease(zoom));
    camera.near = clamp(cp.distanceTo(pose.tgt) * 0.05, 1e-5, 0.02); camera.far = 350; // keep depth precision at every zoom
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    keyWorld.copy(keyView).transformDirection(camera.matrixWorld); key.position.copy(keyWorld).multiplyScalar(10);
    atmoMat.uniforms.uCam.value.copy(camera.position);
    earthMat.uniforms.uMinor.value = 1 - ease(zoom);
    const z = ease(zoom), size = lerp(0.0045, 0.075, z) * (1 - ease(w));

    // satellites
    for (const s of sats) {
      const o = s.s.orbit; s.pos.copy(V(o.pos(tau)));
      s.mesh.visible = size > 1e-5; if (s.mesh.visible) placeModel(s.mesh, s.pos, V(o.vel(tau)), size * 1.25, "own_satellite", 0);
      updateTrail(s.trail, o, tau, lerp(0.85, 0.45, z) * (1 - w));
      s.ring.material.opacity = lerp(0.18, 0.35, z) * (1 - w * 0.8);
    }
    updateBackground(tau);
    bgMat.opacity = lerp(0.65, 0.5, z) * (1 - w * 0.7);

    // other objects (orbit view); in the close-up the real CDM geometry replaces them
    let cC = 0, cE = 0, cB = bg.length;
    for (const o of objs) {
      const e = o.enc, vis = visibility(e, tau) * (o.enc === enc ? 1 - ease(w) : 1);
      o.pos.copy(V(e.orbit.pos(tau)));
      o.mesh.visible = vis > 0.01 && size > 1e-5; o.mesh.material.opacity = vis;
      if (o.mesh.visible) placeModel(o.mesh, o.pos, V(e.orbit.vel(tau)), size, e.type, e.type === "debris" || e.type === "unknown" ? tau * 0.02 + e.id : 0);
      updateTrail(o.trail, e.orbit, tau, vis * lerp(0.7, 0.35, z));
      o.ring.material.opacity = vis * 0.2 * z; o.ring.visible = o.ring.material.opacity > 0.005;
      const inWin = tau >= e.tau + CASE.flyIn && tau <= e.tau + CASE.end;
      o.flag.visible = inWin && o.mesh.visible && w < 0.5;
      if (o.flag.visible) { o.flag.position.copy(o.pos); o.flag.scale.set(0.04, 0.04, 1); }
      if (visibility(e, tau) > 0.5) { const t = e.event.tier; if (t === 2) cC++; else if (t === 1) cE++; else cB++; }
    }
    const ck = `${cC}/${cE}/${cB}`;
    if (ck !== countsKey) { countsKey = ck; countsEl.innerHTML = `Passing now: <b class="${cC ? "c" : ""}">${cC} Critical</b> · <b class="${cE ? "e" : ""}">${cE} Elevated</b> · <b>${cB}</b> below threshold`; }

    // close-up group
    rtn.visible = w > 0.01;
    let manoeuvreOn = false;
    if (rtn.visible) {
      const o = enc.sat.orbit, S = V(o.pos(tau)), R = S.clone().normalize(), T = V(o.vel(tau)), N = new THREE.Vector3().crossVectors(R, T).normalize();
      rtn.matrix.makeBasis(T, R, N.clone().negate()).scale(new THREE.Vector3(1 / R_E, 1 / R_E, 1 / R_E)).setPosition(S);
      rtn.matrixWorldNeedsUpdate = true;
      const seen = enc.cdms.filter((c) => c.tau <= tau), cur = seen[seen.length - 1];
      const tier = cur ? cur.pred_tier : 0;
      shell5.material.color.setHex(tier === 0 ? COL.below : COL.elev); shell1.material.color.setHex(tier === 0 ? COL.below : COL.crit);
      shell5.material.opacity = (tier === 1 ? 0.85 : tier === 2 ? 0.4 : 0.3) * w; shell1.material.opacity = (tier === 2 ? 0.95 : 0.3) * w;
      // dots: each CDM's predicted miss vector (R/T/N at TCA), converging update by update
      const dp = dotGeom.attributes.position, dc = dotGeom.attributes.color, pp = pathGeom.attributes.position;
      seen.forEach((c, j) => {
        const [r, t, n] = c.relative_position_rtn_m; dp.setXYZ(j, t / 1000, r / 1000, -n / 1000); pp.setXYZ(j, t / 1000, r / 1000, -n / 1000);
        const col = new THREE.Color(TIER_HEX[c.pred_tier]), f = j === seen.length - 1 ? 1 : 0.35 + 0.4 * (j / Math.max(1, seen.length - 1));
        dc.setXYZ(j, col.r * f, col.g * f, col.b * f);
      });
      dotGeom.setDrawRange(0, seen.length); pathGeom.setDrawRange(0, seen.length);
      dp.needsUpdate = dc.needsUpdate = pp.needsUpdate = true;
      dots.material.opacity = w; path.material.opacity = 0.5 * w;
      // uncertainty bar (radial sigma) at the latest prediction
      const sg = cur && cur.sigma_r_m && cur.sigma_r_m.chaser < SIGMA_SENTINEL_M && cur.sigma_r_m.target < SIGMA_SENTINEL_M ? Math.hypot(cur.sigma_r_m.chaser, cur.sigma_r_m.target) / 1000 : null;
      sigmaBar.visible = !!(cur && sg != null);
      if (sigmaBar.visible) {
        const [r, t, n] = cur.relative_position_rtn_m, s3 = Math.min(sg, enc.frameKm * 3);
        sigmaGeom.attributes.position.array.set([t / 1000, r / 1000 - s3, -n / 1000, t / 1000, r / 1000 + s3, -n / 1000]);
        sigmaGeom.attributes.position.needsUpdate = true; sigmaBar.material.opacity = 0.7 * w;
      }
      // object at the latest prediction; our satellite at the centre
      const ms = enc.frameKm * 0.035;
      closeObj.visible = !!cur;
      if (cur) { const [r, t, n] = cur.relative_position_rtn_m; closeObj.geometry = geomFor(enc.type); closeObj.position.set(t / 1000, r / 1000, -n / 1000); closeObj.scale.setScalar(ms); closeObj.rotation.set(tau * 0.01, tau * 0.013, 0); closeObj.material.opacity = w; }
      // ping: a soft expanding ring on each real CDM update, coloured by that update's tier
      const pc = enc.cdms.filter((c) => tau >= c.tau && tau < c.tau + PING_TAU).pop();
      ping.visible = !!pc;
      if (pc) { const k = (tau - pc.tau) / PING_TAU; ping.scale.setScalar(0.4 + 6.5 * k); ping.material.color.setHex(TIER_HEX[pc.pred_tier]); ping.material.opacity = (1 - k) * 0.8 * w; }
      // illustrative manoeuvre for a Pc-backed Critical, after its last CDM
      const done = enc.cdms.length && tau >= enc.cdms[enc.cdms.length - 1].tau;
      manoeuvreOn = enc.pcBacked && done;
      ghost.visible = bent.visible = manoeuvreOn;
      let bump = 0;
      if (manoeuvreOn) {
        const lastC = enc.cdms[enc.cdms.length - 1], away = (lastC.relative_position_rtn_m[0] >= 0 ? -1 : 1) * MAN_KM;
        const wid = enc.frameKm * 0.45, a = bentGeom.attributes.position;
        for (let i = 0; i <= 120; i++) { const tt = -enc.frameKm * 1.6 + (i / 120) * enc.frameKm * 3.2; a.setXYZ(i, tt, away * Math.exp(-((tt / wid) ** 2)), 0); }
        a.needsUpdate = true;
        const k = smooth((tau - lastC.tau) / Math.max(30, enc.tau - lastC.tau));
        bump = away * k; ghost.material.opacity = 0.6 * w; bent.material.opacity = 0.9 * w;
      }
      closeOwn.position.set(0, bump, 0); closeOwn.scale.setScalar(ms * 1.2); closeOwn.material.opacity = w;
      // shell labels at the top of each ring (they sit still while the camera holds)
      for (const rl of ringLabels) {
        const sp = w > 0.6 ? toScreen(tmp.a.set(0, rl.km, 0).applyMatrix4(rtn.matrixWorld).clone()) : null;
        rl.d.style.display = sp ? "" : "none";
        if (sp) rl.d.style.transform = `translate(${Math.round(sp[0] + 4)}px, ${Math.round(sp[1] - 14)}px)`;
      }
    } else ringLabels.forEach((rl) => { rl.d.style.display = "none"; });
    manoeuvreEl.hidden = !(manoeuvreOn && w > 0.5);

    renderer.render(scene, camera);

    // labels on our satellites only (fixed offset), hidden in the close-up
    for (const s of sats) {
      const sp = w < 0.3 ? toScreen(s.pos) : null;
      s.label.style.display = sp ? "" : "none";
      if (sp) s.label.style.transform = `translate(${Math.round(sp[0] - s.label.offsetWidth / 2)}px, ${Math.round(sp[1] + 16)}px)`;
    }
    updatePanel(enc, tau, w);
    // leader: from the panel's edge to the object (the line moves; the text does not)
    const panel = document.querySelector(".case-panel").getBoundingClientRect();
    const target = w > 0.5 && closeObj.visible ? closeObj.getWorldPosition(new THREE.Vector3()) : objs[P.encounters.indexOf(enc)].pos;
    const inWin = tau >= enc.tau + CASE.flyIn - 200 && tau <= enc.tau + CASE.end;
    const sp = inWin ? toScreen(target) : null;
    leader.parentElement.style.display = sp && innerWidth > 900 ? "" : "none";
    if (sp) {
      leader.parentElement.style.setProperty("--c", TIER_VAR[enc.event.tier]);
      leader.setAttribute("x1", (sp[0] + 10).toFixed(1)); leader.setAttribute("y1", sp[1].toFixed(1));
      leader.setAttribute("x2", panel.left.toFixed(1)); leader.setAttribute("y2", (panel.top + 60).toFixed(1));
    }
    updateHover();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
