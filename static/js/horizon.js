// Horizon v3: the motion is the real data, as a PREDICTION REPLAY. Each CDM in history[] is a fresh prediction of the
// same moment (closest approach), issued T−x d before it: the predicted miss point (R/T/N at TCA, to scale in km, our
// satellite at the centre) is revised update by update. The current dot eases from one prediction to the next; earlier
// predictions stay as faint dots (no path line: nothing physically travels); the radial uncertainty bar grows or
// shrinks; the 1 km / 5 km shells and the dot take each update's tier. After the last update the panel
// shows the decision and backend trace. Earth and the orbits (real size, shape and tilt from the CDM elements) are calm,
// static context; nothing cruises. Orbits: horizon-orbits.js. Data: GET /api/events, /api/events/{id}, /api/audit.
import { plan, pickCases, background, basis, smooth, R_E } from "./horizon-orbits.js";

const THREE = window.THREE;
const BG_COUNT = 15;
const COL = { bg: 0x080a0b, own: 0x5ea9ff, grey: 0x9ba5a1, crit: 0xff4a3d, elev: 0xe8a33c, below: 0x8a9490 };
const TIER_HEX = [COL.below, COL.elev, COL.crit];
const TIER_NAME = ["Below threshold", "Elevated", "Critical"];
const TIER_CLASS = ["m", "e", "c"];
const TIER_VAR = ["var(--below)", "var(--elev)", "var(--crit)"];
// shells per update tier: [5 km colour, 5 km opacity, 1 km colour, 1 km opacity]
const SHELL = [[COL.below, 0.32, COL.below, 0.32], [COL.elev, 0.85, COL.crit, 0.3], [COL.elev, 0.4, COL.crit, 0.95]];
const SIGMA_SENTINEL_M = 1e7; // the dataset's ~63,781 km placeholder for an unusable sigma
// wall-clock timing (ms): every animation is driven by elapsed time, never by frame count
const T = { tween: 820, first: 1200, hold: 1300, decide: 7500, fadeOut: 380, fadeIn: 620, ping: 900, man: 1800 };
const MAN_KM = 2; // illustrative avoidance offset at TCA
const MAXC = 64;
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
const sigmaKm = (h) => {
  const s = h.sigma_r_m || {};
  return s.chaser < SIGMA_SENTINEL_M && s.target < SIGMA_SENTINEL_M ? Math.hypot(s.chaser, s.target) / 1000 : null;
};
const sigmaText = (h) => { const s = sigmaKm(h); return s == null ? "no usable radial uncertainty (placeholder sigma)" : `radial σ ±${fmtDist(s * 1000)}`; };

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
  const cases = await Promise.all(picked.map(async (c) => {
    const r = await fetch(`/api/events/${c.event.event_id}`);
    return { ...c, event: r.ok ? await r.json() : c.event };
  }));
  const below = list.filter((e) => e.tier === 0 && e.latest && !cases.some((c) => c.event.event_id === e.event_id))
    .sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days).slice(0, BG_COUNT);
  const n = [0, 0, 0]; for (const e of list) n[e.tier] = (n[e.tier] || 0) + 1;
  $("#counts").innerHTML = `${list.length.toLocaleString("en")} events · <b class="c">${n[2]} Critical</b> · <b class="e">${n[1]} Elevated</b> · <b>${n[0].toLocaleString("en")}</b> below threshold`;
  const P = plan(cases, list);
  if (!P.encounters.some((e) => e.cdms.length)) return showError(new Error("the cases have no CDM history"));
  P.encounters = P.encounters.filter((e) => e.cdms.length);
  start(P, icons, background(below));
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.00002, 400);
  const keyView = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  scene.add(key, key.target);

  // ---------- Earth, atmosphere, stars (still) ----------
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uLight: { value: keyView }, uSun: { value: new THREE.Vector3(0, 1, 0) },
      uBase: { value: new THREE.Color(0x0a100f) }, uLine: { value: new THREE.Color(0x2b3c37) },
      uRim: { value: new THREE.Color(0x1f4f80) }, uHaze: { value: new THREE.Color(0x3b78b8) },
    },
    vertexShader: `varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      void main() { vObj = normal; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uLight; uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uRim; uniform vec3 uSun; uniform vec3 uHaze;
      varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN); vec3 Vd = normalize(vV);
        float lat = degrees(asin(clamp(normalize(vObj).y, -1.0, 1.0)));
        float w = max(fwidth(lat), 1e-4);
        float d10 = abs(fract(lat / 10.0 + 0.5) - 0.5) * 10.0, d30 = abs(fract(lat / 30.0 + 0.5) - 0.5) * 30.0;
        float lines = (0.45 * (1.0 - smoothstep(0.0, w * 1.1, d10)) + 0.8 * (1.0 - smoothstep(0.0, w * 1.4, d30))) * (1.0 - smoothstep(0.6, 3.5, w));
        float diff = max(dot(N, uLight), 0.0);
        float day = smoothstep(-0.12, 0.3, dot(normalize(vObj), uSun));
        float edge = 1.0 - max(dot(N, Vd), 0.0);
        vec3 col = uBase * (0.55 + 0.35 * diff + 0.75 * day) + uLine * lines * (0.4 + 0.3 * diff + 0.3 * day)
                 + uRim * pow(edge, 5.0) * (0.12 + 0.6 * day) + uHaze * pow(edge, 2.4) * day * 0.16;
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120), earthMat));
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uSun: earthMat.uniforms.uSun, uColor: { value: new THREE.Color(0x4a8fd6) } },
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
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 128, 96), atmoMat));
  {
    const n = 700, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      pos.set([Math.cos(a) * s * 300, z * 300, Math.sin(a) * s * 300], i * 3);
      const b = 0.16 + rnd() ** 3 * 0.5; col.set([b, b, b * 1.04], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
  }

  // ---------- shared helpers (everything is built once; frames only move existing objects) ----------
  const lineMat = (hex, opacity) => new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false });
  const ellipseLine = (o, hex, opacity, n = 2048) => {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(V(o.atNu((i / n) * Math.PI * 2)));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(hex, opacity));
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
  const ringTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d"); x.strokeStyle = "#fff"; x.lineWidth = 5; x.beginPath(); x.arc(64, 64, 56, 0, Math.PI * 2); x.stroke();
    return new THREE.CanvasTexture(c);
  })();
  const discTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0, "#fff"); g.addColorStop(0.72, "#fff"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.beginPath(); x.arc(32, 32, 31, 0, Math.PI * 2); x.fill();
    return new THREE.CanvasTexture(c);
  })();
  const circleGeom = (r, n = 128) => {
    const pts = []; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
    return new THREE.BufferGeometry().setFromPoints(pts);
  };
  const pointsOf = (n, hex, size, opacity = 1) => {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: hex, size, map: discTex, sizeAttenuation: false, transparent: true, opacity, depthWrite: false }));
    p.frustumCulled = false; return p;
  };

  // ---------- orbits (static thin lines; real size, shape, tilt) ----------
  const satLines = new Map(P.sats.map((s) => { const l = ellipseLine(s.orbit, COL.own, 0.2); scene.add(l); return [s.id, l]; }));
  const chaserLines = P.encounters.map((enc) => { const l = ellipseLine(enc.orbit, 0x6f7b77, 0.4); l.visible = false; scene.add(l); return l; });

  // ---------- globe-only context: markers, the active case's short static trails, ~15 static specks ----------
  const globe = new THREE.Group(); scene.add(globe);
  const satPts = pointsOf(P.sats.length, COL.own, 6, 0.95); globe.add(satPts);
  const objPt = pointsOf(1, COL.grey, 6, 0.95); globe.add(objPt);
  const flag = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, sizeAttenuation: false }));
  flag.scale.set(0.045, 0.045, 1); globe.add(flag);
  const TRAIL_N = 64;
  const makeTrail = (hex) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
    const c = new Float32Array(TRAIL_N * 3), base = new THREE.Color(hex);
    for (let i = 0; i < TRAIL_N; i++) { const f = (1 - i / (TRAIL_N - 1)) ** 1.6 * 0.9; c.set([base.r * f, base.g * f, base.b * f], i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.frustumCulled = false; globe.add(l); return l;
  };
  const satTrail = makeTrail(COL.own), objTrail = makeTrail(0xa9b2ae);
  const fillTrail = (line, o, tau) => {
    const a = line.geometry.attributes.position, dt = (o.period * 0.06) / TRAIL_N;
    for (let i = 0; i < TRAIL_N; i++) { const p = o.pos(tau - i * dt); a.setXYZ(i, p[0], p[1], p[2]); }
    a.needsUpdate = true;
  };
  const bgPts = pointsOf(bg.length, 0x8a9490, 2.4, 0.55); globe.add(bgPts);
  const bgWorld = bg.map((b, j) => { const p = b.orbit.pos(P.encounters[0].tau); bgPts.geometry.attributes.position.setXYZ(j, p[0], p[1], p[2]); return V(p); });

  // ---------- close-up: the real CDM updates in our satellite's R/T/N frame, in km ----------
  // Group axes: x = T (along-track), y = R (radial), z = -N; children in km (group scale 1 / R_E).
  const rtn = new THREE.Group(); rtn.matrixAutoUpdate = false; scene.add(rtn);
  const axes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)]), lineMat(0x3a4744, 0.45));
  rtn.add(axes);
  const trailPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 7, map: discTex, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
  trailPts.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXC * 3), 3));
  trailPts.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAXC * 3), 3));
  trailPts.frustumCulled = false; rtn.add(trailPts);
  const head = pointsOf(1, COL.elev, 13); rtn.add(head); // single vertex at the origin; moved via .position
  const ping = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, opacity: 0 }));
  ping.visible = false; rtn.add(ping);
  const sigmaBar = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)]), lineMat(0xe6ebe8, 0.7));
  rtn.add(sigmaBar);
  const ownMat = new THREE.MeshStandardMaterial({ color: COL.own, flatShading: true, roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide });
  const closeOwn = new THREE.Mesh(geomFor("own_satellite"), ownMat); rtn.add(closeOwn);
  const bent = new THREE.Line(new THREE.BufferGeometry(), lineMat(COL.own, 0));
  bent.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(121 * 3), 3));
  bent.frustumCulled = false; bent.visible = false; rtn.add(bent);
  // shells: sphere outlines, turned to face the camera (recomputed only when the camera moves)
  const shellG = new THREE.Group(); scene.add(shellG);
  const shell5 = new THREE.Line(circleGeom(5), new THREE.LineDashedMaterial({ color: COL.elev, transparent: true, opacity: 0.3, dashSize: 0.3, gapSize: 0.25, depthWrite: false }));
  shell5.computeLineDistances();
  const shell1 = new THREE.Line(circleGeom(1), lineMat(COL.crit, 0.3));
  shellG.add(shell5, shell1);

  for (const enc of P.encounters) {
    enc.pts = enc.cdms.map((h) => { const [r, t, n] = h.relative_position_rtn_m; return new THREE.Vector3(t / 1000, r / 1000, -n / 1000); });
    const ext = Math.max(6, ...enc.pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))));
    enc.frameKm = Math.min(60, ext * 1.2);
    const S = V(enc.X), R = S.clone().normalize(), Tv = V(enc.sat.orbit.vel(enc.tau)), N = new THREE.Vector3().crossVectors(R, Tv).normalize();
    enc.basis = { S, R, T: Tv, N };
  }

  // ---------- labels (positioned only when the camera changes) ----------
  const labelsEl = $("#labels");
  const mkLabel = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; labelsEl.append(d); return d; };
  const ringLabels = [5, 1].map((km) => ({ km, d: mkLabel("ring-label", `${km} km`) }));
  const axisLabels = [mkLabel("ring-label axis", "R radial"), mkLabel("ring-label axis", "T along-track"), mkLabel("ring-label axis", "N cross-track")];
  const satLabel = mkLabel("sat-label", ""), evtLabel = mkLabel("ring-label evt", "");

  // ---------- state ----------
  let ci = 0, ui = 0, view = hash.get("view") === "globe" ? 1 : 0, playing = !reduced, yaw = 0, pitch = 0;
  let tweenStart = 0, tweenDur = 0, landed = true, dwell = 0, pingStart = 0, manStart = 0, trailCount = 0;
  let cameraDirty = true, needsRender = true, fade = null;
  const from = new THREE.Vector3(), to = new THREE.Vector3(), cur = new THREE.Vector3();
  const fromCol = new THREE.Color(), toCol = new THREE.Color(), curCol = new THREE.Color(COL.elev);
  const sh = { from: [new THREE.Color(), 0, new THREE.Color(), 0], to: [new THREE.Color(), 0, new THREE.Color(), 0] };
  const shCur = [new THREE.Color(COL.below), 0.3, new THREE.Color(COL.below), 0.3];
  let sigFrom = 0, sigTo = 0, sigCur = 0;
  const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4() };
  const enc = () => P.encounters[ci];

  // ---------- docked panel: text only changes when its value does; blocks cross-fade (no forced reflow) ----------
  const blocks = { head: $("#case-head"), title: $("#b-title"), cdm: $("#b-cdm"), cls: $("#b-class"), trace: $("#b-trace") };
  const lastHtml = {};
  const fadeIn = (el) => { if (!reduced && el.animate) el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 320, easing: "ease-out" }); };
  const setBlock = (k, html) => {
    if (lastHtml[k] === html) return;
    lastHtml[k] = html; blocks[k].innerHTML = html;
    if (html && k !== "head") fadeIn(blocks[k]);
  };
  const xfLast = new WeakMap();
  const xfSet = (box, html) => { // two stacked layers; swap and cross-fade
    if (!box || xfLast.get(box) === html) return;
    xfLast.set(box, html);
    const [a, b] = box.children, next = a.classList.contains("on") ? b : a, prev = next === a ? b : a;
    next.innerHTML = html; next.classList.add("on"); prev.classList.remove("on");
  };
  const traceBtn = $("#trace-toggle");
  let traceOn = true;
  try { traceOn = localStorage.getItem("horizon.trace") !== "off"; } catch { /* storage blocked: default on */ }
  const syncTrace = () => { traceBtn.setAttribute("aria-pressed", String(traceOn)); blocks.trace.style.display = traceOn ? "" : "none"; };
  traceBtn.addEventListener("click", () => {
    traceOn = !traceOn; syncTrace();
    try { localStorage.setItem("horizon.trace", traceOn ? "on" : "off"); } catch { /* ignore */ }
  });
  syncTrace();
  let traceTimers = [];
  function caseNote(E) {
    const e = E.event, c = e.certificate || {};
    const sc = c.model_score != null && c.threshold != null ? `${c.model_score.toFixed(4)} ${c.model_score < c.threshold ? "<" : "≥"} ${c.threshold.toFixed(4)}` : null;
    switch (E.kind.key) {
      case "dist": return `Pc doesn't back a manoeuvre → analyst review`;
      case "pc": return `Illustrative avoidance manoeuvre shown <span class="m">(operator-approved; never commanded by Second Look)</span>`;
      case "kept": return sc ? `Model kept Elevated: score ${sc}` : "Model kept Elevated";
      case "demoted": return sc ? `Model demoted: score ${sc} → below threshold` : "Model demoted: score < threshold";
      case "watch": { const r = (e.action?.reasons || []).find((x) => /watch|clos|threshold/i.test(x)); return `Escalation watch${r ? `: <span class="m">${esc(r)}</span>` : ""}`; }
      default: return "";
    }
  }
  function showDecision() {
    const E = enc(), e = E.event;
    setBlock("cls", `<div class="cls" style="--c:${TIER_VAR[e.tier]}"><span class="tier">${TIER_NAME[e.tier]}</span> (${esc(titleCase(e.action?.queue))}) · ${basis(e)}</div>
      <div class="note">${caseNote(E)}</div><a href="/static/review.html#event=${e.event_id}">Open decision record</a>`);
    traceTimers.forEach(clearTimeout); traceTimers = [];
    const steps = traceSteps(e);
    setBlock("trace", `<div class="th">Backend trace</div><ol class="trace" aria-label="Backend trace">${steps.map(([k, v], j) =>
      `<li class="${reduced ? "on" : ""}"><span class="n">${j + 1}</span><span class="k">${k}</span><span class="v">${v}</span></li>`).join("")}</ol>`);
    if (!reduced) [...blocks.trace.querySelectorAll("li")].forEach((li, j) => traceTimers.push(setTimeout(() => li.classList.add("on"), 150 + j * 260)));
    if (!audit) { // fill the guardrail line once the audit arrives (no polling per frame)
      const fill = () => { if (!audit) return traceTimers.push(setTimeout(fill, 300)); const v = blocks.trace.querySelector("li:last-child .v"); if (v) v.innerHTML = traceSteps(e).at(-1)[1]; };
      traceTimers.push(setTimeout(fill, 300));
    }
    if (E.pcBacked) { manStart = reduced ? -1e9 : performance.now(); bent.visible = true; manoeuvreEl.hidden = view !== 0; }
  }
  function hideDecision() {
    traceTimers.forEach(clearTimeout); traceTimers = [];
    setBlock("cls", ""); setBlock("trace", "");
    manStart = 0; bent.visible = false; closeOwn.position.set(0, 0, 0); manoeuvreEl.hidden = true;
  }

  // ---------- transport: play/pause, ‹ › updates, ticks at the real time to TCA ----------
  const playBtn = $("#play"), ticksEl = $("#ticks"), pheadEl = $("#phead"), readout = $("#readout"), scaleEl = $("#scale");
  const axisL = $("#axis-l");
  const manoeuvreEl = $("#manoeuvre"), replayCap = $("#replay-cap");
  let pctFrom = 0, pctTo = 0;
  const pctOf = (E, j) => { const t0 = E.cdms[0].time_to_tca_days || 1; return clamp(((t0 - E.cdms[j].time_to_tca_days) / t0) * 100, 0, 100); };
  const setPlaying = (p) => { playing = p; playBtn.setAttribute("aria-pressed", String(p)); playBtn.setAttribute("aria-label", p ? "Pause" : "Play"); };

  // ---------- camera ----------
  function poseFor(E) {
    const { S, R, T: Tv, N } = E.basis;
    if (view === 0) {
      const d = (E.frameKm * 3.3) / R_E;
      const dir = tmp.a.copy(N).negate().addScaledVector(R, 0.3).addScaledVector(Tv, -0.32).normalize();
      return { pos: S.clone().addScaledVector(dir, d), tgt: S.clone(), up: R.clone() };
    }
    const u = S.clone().normalize();
    const dir = u.clone().addScaledVector(N, -0.85).addScaledVector(new THREE.Vector3(0, 1, 0), 0.2).normalize(); // orbit seen open, not edge-on
    return { pos: dir.multiplyScalar(5.6), tgt: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  }
  function applyCamera() {
    const E = enc(), pose = poseFor(E);
    const off = pose.pos.clone().sub(pose.tgt);
    off.applyAxisAngle(pose.up, yaw);
    off.applyAxisAngle(tmp.b.crossVectors(off, pose.up).normalize(), pitch);
    const cp = pose.tgt.clone().add(off);
    if (cp.length() < 1.0005) cp.setLength(1.0005);
    camera.position.copy(cp); camera.up.copy(pose.up); camera.lookAt(pose.tgt);
    const dist = cp.distanceTo(pose.tgt);
    camera.near = clamp(dist * 0.05, 1e-5, 0.05); camera.far = 350;
    const wide = innerWidth > 900, shift = wide ? (Math.min(384, innerWidth * 0.3) + 32) / 2 : 0, lift = wide ? 0 : innerHeight * 0.16;
    camera.setViewOffset(innerWidth, innerHeight, shift, lift, innerWidth, innerHeight);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    key.position.copy(keyView).transformDirection(camera.matrixWorld).multiplyScalar(10);
    atmoMat.uniforms.uCam.value.copy(camera.position);
    shellG.position.copy(E.basis.S); shellG.quaternion.copy(camera.quaternion); shellG.scale.setScalar(1 / R_E);
    shellG.updateMatrixWorld();
    positionLabels();
  }
  const isOccluded = (pos) => { const d = tmp.b.copy(pos).sub(camera.position); const k = clamp(-camera.position.dot(d) / d.lengthSq(), 0, 1); return tmp.c.copy(camera.position).addScaledVector(d, k).length() < 1; };
  const toScreen = (pos) => {
    const p = tmp.a.copy(pos).project(camera);
    if (p.z >= 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05 || isOccluded(pos)) return null;
    return [(p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight];
  };
  const place = (el, sp, dx, dy) => {
    el.style.display = sp ? "" : "none";
    if (sp) el.style.transform = `translate(${Math.round(sp[0] + dx)}px, ${Math.round(sp[1] + dy)}px)`;
  };
  function positionLabels() {
    const E = enc(), close = view === 0;
    for (const rl of ringLabels) place(rl.d, close ? toScreen(tmp.c.set(rl.km * 0.5, rl.km * 0.866, 0).applyMatrix4(shellG.matrixWorld).clone()) : null, 4, -14);
    rtn.updateMatrixWorld();
    place(axisLabels[0], close ? toScreen(tmp.c.set(0, E.frameKm * 0.8, 0).applyMatrix4(rtn.matrixWorld).clone()) : null, 6, -8);
    place(axisLabels[1], close ? toScreen(tmp.c.set(E.frameKm * 1.05, 0, 0).applyMatrix4(rtn.matrixWorld).clone()) : null, 6, 4);
    place(axisLabels[2], close ? toScreen(tmp.c.set(0, 0, E.frameKm * 0.8).applyMatrix4(rtn.matrixWorld).clone()) : null, 6, 2);
    place(satLabel, !close ? toScreen(V(E.X)) : null, -44, 28);
    place(evtLabel, !close ? toScreen(V(E.X)) : null, 14, -22);
  }

  // ---------- applying a case (all per-case work happens here, once) ----------
  function applyCase(i) {
    ci = (i + P.encounters.length) % P.encounters.length;
    const E = enc(), e = E.event, L = e.latest, N = E.cdms.length;
    yaw = 0; pitch = 0;
    const { S, R, T: Tv, N: Nv } = E.basis;
    rtn.matrix.makeBasis(Tv, R, Nv.clone().negate()).scale(new THREE.Vector3(1 / R_E, 1 / R_E, 1 / R_E)).setPosition(S);
    rtn.matrixWorldNeedsUpdate = true;
    earthMat.uniforms.uSun.value.copy(R).multiplyScalar(0.6).addScaledVector(Nv, 1).addScaledVector(Tv, -0.3).normalize();
    axes.scale.setScalar(E.frameKm * 0.8);
    const ms = E.frameKm * 0.035;
    closeOwn.scale.setScalar(ms * 1.8);
    closeOwn.matrixAutoUpdate = true;
    closeOwn.quaternion.identity();
    // trail: every update's point and dimmed tier colour (drawRange reveals them one by one)
    const tp = trailPts.geometry.attributes.position, tc = trailPts.geometry.attributes.color;
    E.pts.slice(0, MAXC).forEach((p, j) => {
      tp.setXYZ(j, p.x, p.y, p.z);
      fromCol.setHex(TIER_HEX[E.cdms[j].pred_tier]).multiplyScalar(0.55);
      tc.setXYZ(j, fromCol.r, fromCol.g, fromCol.b);
    });
    tp.needsUpdate = tc.needsUpdate = true;
    // illustrative manoeuvre path (built once per case)
    if (E.pcBacked) {
      const lastC = E.cdms[N - 1], away = (lastC.relative_position_rtn_m[0] >= 0 ? -1 : 1) * MAN_KM;
      const wid = E.frameKm * 0.45, a = bent.geometry.attributes.position;
      for (let k = 0; k <= 120; k++) { const tt = -E.frameKm * 1.6 + (k / 120) * E.frameKm * 3.2; a.setXYZ(k, tt, away * Math.exp(-((tt / wid) ** 2)), 0); }
      a.needsUpdate = true; E.away = away;
    }
    hideDecision();
    // globe context
    P.sats.forEach((s, j) => { const p = s.orbit.pos(E.tau); satPts.geometry.attributes.position.setXYZ(j, p[0], p[1], p[2]); satLines.get(s.id).material.opacity = s.id === E.sat.id ? 0.55 : 0.16; });
    satPts.geometry.attributes.position.needsUpdate = true;
    objPt.geometry.attributes.position.setXYZ(0, E.X[0], E.X[1], E.X[2]); objPt.geometry.attributes.position.needsUpdate = true;
    flag.position.copy(S); flag.material.color.setHex(TIER_HEX[e.tier]);
    fillTrail(satTrail, E.sat.orbit, E.tau); fillTrail(objTrail, E.orbit, E.tau);
    satLabel.textContent = `Sat M${E.sat.id} · ${Math.round(E.sat.altKm)} km`;
    evtLabel.textContent = `EVT ${E.id}`;
    // panel + transport
    setBlock("head", `<span>Case <b>${ci + 1}/${P.encounters.length}</b></span><span>${esc(E.kind.label)}</span>`);
    setBlock("title", `<div class="t1">EVT ${e.event_id} · ${esc(typeLabel(E.type))}</div><div class="t2">Sat M${E.sat.id} · crossing at ${E.latDeg.toFixed(1)}° · ${(L.relative_speed_ms / 1000).toFixed(1)} km/s · latest CDM T−${L.time_to_tca_days.toFixed(2)} d</div>`);
    setBlock("cdm", `<div class="xf cdm-line" id="x-line"><div></div><div></div></div><div class="ticks-row">${E.cdms.map(() => "<i></i>").join("")}</div><div class="xf sub" id="x-sub"><div></div><div></div></div>`);
    ticksEl.innerHTML = E.cdms.map((c, j) => `<button type="button" data-j="${j}" style="left:${pctOf(E, j).toFixed(2)}%;--c:${TIER_VAR[c.pred_tier]}" aria-label="CDM ${j + 1} of ${N}, T−${c.time_to_tca_days.toFixed(2)} d"></button>`).join("");
    axisL.textContent = `T−${E.cdms[0].time_to_tca_days.toFixed(1)} d`;
    scaleEl.innerHTML = view === 0
      ? `To scale · shells 1, 5 km · view ±${Math.round(E.frameKm)} km<br>Our satellite at centre · model not to scale`
      : `Orbits: real size, shape, tilt<br>Markers not to scale`;
    chaserLines.forEach((l, j) => { l.visible = view === 1 && j === ci; });
    rtn.visible = shellG.visible = view === 0;
    globe.visible = view === 1;
    replayCap.hidden = view !== 0;
    for (const [id, l] of satLines) l.visible = view === 1 || id === E.sat.id;
    cameraDirty = true;
    goUpdate(reduced ? N - 1 : 0, true);
  }

  function goUpdate(k, instant = false) {
    const E = enc(), N = E.cdms.length;
    k = clamp(k, 0, N - 1);
    const back = k < ui && !instant, h = E.cdms[k];
    const anim = !instant && !reduced;
    from.copy(anim ? cur : E.pts[k]); to.copy(E.pts[k]);
    fromCol.copy(anim ? curCol : toCol.setHex(TIER_HEX[h.pred_tier])); toCol.setHex(TIER_HEX[h.pred_tier]);
    const st = SHELL[h.pred_tier];
    for (const j of [0, 2]) { sh.from[j].copy(anim ? shCur[j] : sh.to[j].setHex(st[j])); sh.to[j].setHex(st[j]); }
    for (const j of [1, 3]) { sh.from[j] = anim ? shCur[j] : st[j]; sh.to[j] = st[j]; }
    const s = sigmaKm(h); sigFrom = anim ? sigCur : (s ?? 0); sigTo = s ?? 0;
    pctFrom = anim ? lerp(pctFrom, pctTo, ease(clamp((performance.now() - tweenStart) / (tweenDur || 1), 0, 1))) : pctOf(E, k); pctTo = pctOf(E, k);
    tweenStart = performance.now(); tweenDur = anim ? T.tween : 0; landed = false; dwell = 0;
    trailCount = back ? k + 1 : k;
    ui = k;
    trailPts.geometry.setDrawRange(0, trailCount);
    if (k < N - 1) hideDecision();
    // panel: the update line cross-fades; ticks/readout change only here
    xfSet($("#x-line"), `<span class="nw"><span class="n">CDM ${h.n}/${h.N}</span> · received T−${h.time_to_tca_days.toFixed(1)} d</span> · <span class="nw">predicted miss ${fmtDist(h.miss_distance_m)}</span> · <span class="nw">Pc ≤ ${fmtPc(h.max_risk_estimate_log10)}</span> · <span class="nw" style="color:${TIER_VAR[h.pred_tier]}">${TIER_NAME[h.pred_tier]}</span>`);
    xfSet($("#x-sub"), `Predicted at closest approach · ${sigmaText(h)}`);
    [...blocks.cdm.querySelectorAll(".ticks-row i")].forEach((el, j) => { el.className = j <= k ? `t${E.cdms[j].pred_tier}` : ""; });
    [...ticksEl.children].forEach((el, j) => { el.classList.toggle("on", j <= k); el.setAttribute("aria-current", j === k ? "step" : "false"); });
    readout.innerHTML = `CDM ${h.n}/${h.N} received <b>T−${h.time_to_tca_days.toFixed(2)} d</b>`;
    needsRender = true;
  }

  // case change: a gentle dip of the scene (camera never flies); reduced motion switches instantly
  function goCase(i, then) {
    if (reduced) { applyCase(i); if (then) then(); return; }
    if (fade) return;
    document.body.classList.add("dim");
    fade = { t: performance.now(), apply: () => { applyCase(i); if (then) then(); } };
  }
  function setView(v) {
    if (v === view) return;
    const go = () => { view = v; viewBtns.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.view) === view))); applyCaseView(); };
    if (reduced) return go();
    if (fade) return;
    document.body.classList.add("dim");
    fade = { t: performance.now(), apply: go };
  }
  function applyCaseView() { // view switch without resetting the update sequence
    const E = enc();
    chaserLines.forEach((l, j) => { l.visible = view === 1 && j === ci; });
    rtn.visible = shellG.visible = view === 0; globe.visible = view === 1;
    replayCap.hidden = view !== 0;
    for (const [id, l] of satLines) l.visible = view === 1 || id === E.sat.id;
    scaleEl.innerHTML = view === 0
      ? `To scale · shells 1, 5 km · view ±${Math.round(E.frameKm)} km<br>Our satellite at centre · model not to scale`
      : `Orbits: real size, shape, tilt<br>Markers not to scale`;
    manoeuvreEl.hidden = !(view === 0 && manStart);
    yaw = 0; pitch = 0; cameraDirty = true;
  }

  // ---------- controls ----------
  const step = (d) => {
    const E = enc(), N = E.cdms.length;
    if (ui + d >= 0 && ui + d < N) return goUpdate(ui + d);
    if (d > 0) return goCase(ci + 1);
    goCase(ci - 1, () => goUpdate(enc().cdms.length - 1, true));
  };
  playBtn.addEventListener("click", () => setPlaying(!playing));
  $("#upd-prev").addEventListener("click", () => step(-1));
  $("#upd-next").addEventListener("click", () => step(1));
  ticksEl.addEventListener("click", (ev) => { const b = ev.target.closest("button[data-j]"); if (b) goUpdate(Number(b.dataset.j)); });
  $("#case-prev").addEventListener("click", () => goCase(ci - 1));
  $("#case-next").addEventListener("click", () => goCase(ci + 1));
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLButtonElement || t instanceof HTMLInputElement || t instanceof HTMLAnchorElement) return;
    if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  });
  const viewBtns = [...document.querySelectorAll(".views button")];
  viewBtns.forEach((b) => { b.setAttribute("aria-pressed", String(Number(b.dataset.view) === view)); b.addEventListener("click", () => setView(Number(b.dataset.view))); });

  // drag to look around (camera recomputed only on input)
  const pointers = new Map(); let mouse = null, hoverPending = false;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); canvas.classList.add("dragging"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) { mouse = [e.clientX, e.clientY]; hoverPending = true; return; }
    mouse = null;
    const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const lim = view === 0 ? 0.6 : 1.3;
    yaw = clamp(yaw - ((e.clientX - px) / innerWidth) * 2.2, -lim, lim);
    pitch = clamp(pitch + ((e.clientY - py) / innerHeight) * 1.6, -lim * 0.5, lim * 0.5);
    cameraDirty = true;
  });
  const up = (e) => { pointers.delete(e.pointerId); if (!pointers.size) canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { mouse = null; hoverPending = true; });

  const tip = $("#tip");
  let tipHtml = "";
  function updateHover() {
    let best = null, bd = 14 * 14;
    if (mouse && view === 1) {
      const E = enc();
      const consider = (pos, html) => { const sp = toScreen(pos); if (!sp) return; const d = (sp[0] - mouse[0]) ** 2 + (sp[1] - mouse[1]) ** 2; if (d < bd) { bd = d; best = html; } };
      bg.forEach((b, j) => consider(bgWorld[j], `EVT ${b.id} <span class="m">· ${esc(typeLabel(b.type))} · below threshold</span>`));
      consider(V(E.X), `EVT ${E.id} <span class="m">· ${esc(typeLabel(E.type))} ·</span> <span class="${TIER_CLASS[E.event.tier]}">${TIER_NAME[E.event.tier]}</span>`);
      P.sats.forEach((s) => consider(V(s.orbit.pos(E.tau)), `<span class="o">Sat M${s.id}</span> <span class="m">· ${Math.round(s.altKm)} km · a ${Math.round(s.smaKm)} km · i ${s.incDeg.toFixed(1)}°</span>`));
    }
    tip.hidden = !best;
    if (best) {
      if (best !== tipHtml) { tipHtml = best; tip.innerHTML = best; }
      tip.style.transform = `translate(${Math.round(Math.min(mouse[0] + 14, innerWidth - 320))}px, ${Math.round(Math.max(8, mouse[1] - 30))}px)`;
    }
  }

  function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; cameraDirty = true; }
  addEventListener("resize", resize); resize();

  // ---------- initial state from the hash ----------
  const byId = new Map(P.encounters.map((e, j) => [e.id, j]));
  const demo = byId.get(Number(hash.get("demo")));
  applyCase(demo ?? 0);
  if (demo != null) {
    setPlaying(false);
    const n = Number(hash.get("cdm"));
    goUpdate(n >= 1 ? n - 1 : enc().cdms.length - 1, true);
  } else setPlaying(playing && !hash.has("pause"));

  // ---------- frame loop: delta time, no allocation, render only while something changes ----------
  const stats = { frames: 0, work: 0, rendered: 0 };
  window.__hzStats = stats;
  let last = performance.now();
  function frame(now) {
    const t0 = performance.now();
    const dt = Math.min(100, now - last); last = now;
    let anim = false;
    const E = enc(), N = E.cdms.length;

    // dip fade between cases / views (CSS opacity transition on the canvas; the switch happens while it is dark)
    if (fade && now - fade.t >= T.fadeOut) { const f = fade; fade = null; f.apply(); document.body.classList.remove("dim"); }

    // the update tween
    const k = tweenDur > 0 ? clamp((now - tweenStart) / tweenDur, 0, 1) : 1, e = ease(k);
    if (k < 1 || !landed) {
      anim = true;
      cur.lerpVectors(from, to, e);
      head.position.copy(cur);
      curCol.copy(fromCol).lerp(toCol, e); head.material.color.copy(curCol);
      for (const j of [0, 2]) shCur[j].copy(sh.from[j]).lerp(sh.to[j], e);
      for (const j of [1, 3]) shCur[j] = lerp(sh.from[j], sh.to[j], e);
      shell5.material.color.copy(shCur[0]); shell5.material.opacity = shCur[1];
      shell1.material.color.copy(shCur[2]); shell1.material.opacity = shCur[3];
      sigCur = lerp(sigFrom, sigTo, e);
      sigmaBar.visible = sigTo > 0 || sigCur > 0.001;
      sigmaBar.position.copy(cur); sigmaBar.scale.set(1, Math.max(1e-4, Math.min(sigCur, E.frameKm * 3)), 1);
      sigmaBar.material.opacity = 0.7 * (sigTo > 0 ? 1 : 1 - e);
      pheadEl.style.transform = `translateX(${lerp(pctFrom, pctTo, e).toFixed(2)}%)`;
      if (k >= 1 && !landed) {
        landed = true; trailPts.geometry.setDrawRange(0, ui);
        if (tweenDur > 0) { pingStart = now; ping.material.color.copy(toCol); }
        if (ui === N - 1) showDecision();
      }
    }
    // ping on each landed update, coloured by its tier
    if (pingStart) {
      const p = (now - pingStart) / T.ping;
      if (p < 1) { ping.visible = true; ping.position.copy(cur); ping.scale.setScalar(E.frameKm * (0.04 + 0.22 * smooth(p))); ping.material.opacity = (1 - p) * 0.8; anim = true; }
      else { ping.visible = false; pingStart = 0; anim = true; }
    }
    // illustrative manoeuvre after the decision (Pc-backed Critical)
    if (manStart && E.pcBacked) {
      const m = clamp((now - manStart) / T.man, 0, 1), s = smooth(m);
      closeOwn.position.set(0, E.away * s, 0); bent.material.opacity = 0.9 * s;
      if (m < 1) anim = true;
    }
    // auto-advance by elapsed time while playing
    if (playing && landed && !fade) {
      dwell += dt;
      const need = ui === N - 1 ? T.decide : ui === 0 ? T.first : T.hold;
      if (dwell >= need) { if (ui < N - 1) goUpdate(ui + 1); else goCase(ci + 1); }
    }
    if (cameraDirty) { cameraDirty = false; applyCamera(); anim = true; hoverPending = true; }
    if (hoverPending) { hoverPending = false; updateHover(); }
    if (anim || needsRender) { renderer.render(scene, camera); needsRender = false; stats.rendered++; }
    stats.frames++; stats.work += performance.now() - t0;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
