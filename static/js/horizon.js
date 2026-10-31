// Horizon: one three.js scene, two camera poses (HORIZON chase shot near the limb, GLOBE pulled back), blended by a
// single zoom value. Orbits come from horizon-orbits.js; this file draws them and runs the replay clock.
// Data: GET /api/events (docs/CONTRACT.md §4). The motion is illustrative; the page says so in plain words.
import { plan, background, visibility, basis, MISS_SCALE, SPEED } from "./horizon-orbits.js";

const THREE = window.THREE;
const MAX_OBJECTS = 16; // flagged (Critical + Elevated), soonest by time to TCA
const BG_COUNT = 40; // real below-threshold events, drawn as dim specks
const WARN_BEFORE_S = 3.5; // replay seconds before closest approach that a flag turns on
const WARN_AFTER_S = 1.5;
const COL = { bg: 0x080a0b, own: 0x5ea9ff, grey: 0x9ba5a1, crit: 0xff4a3d, elev: 0xe8a33c };
const TIER_HEX = { 1: COL.elev, 2: COL.crit };
const TIER_NAME = { 1: "Elevated", 2: "Critical" };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hash = new URLSearchParams(location.hash.slice(1));

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDist = (m) => (m < 10_000 ? `${Math.round(m).toLocaleString("en")} m` : `${(m / 1000).toFixed(1)} km`);
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const typeLabel = (t) => ({ rocket_body: "rocket body" })[t] || t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

async function main() {
  let events, icons;
  try {
    const [res, ic] = await Promise.all([fetch("/api/events"), fetch("/static/icons.json")]);
    if (!res.ok) throw new Error(`/api/events ${res.status}`);
    events = (await res.json()).events;
    icons = ic.ok ? await ic.json() : null;
  } catch (err) {
    showError(err);
    return;
  }
  const chosen = pick(events);
  if (!chosen.length) return showError(new Error("no Critical or Elevated events"));
  const below = events.filter((e) => e.tier === 0 && e.latest && e.latest.time_to_tca_days != null)
    .sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days).slice(0, BG_COUNT);
  const P = plan(chosen);
  start(P, icons, background(below, P));
}

/** The soonest Critical and Elevated events by time to TCA (the #demo event is kept in if it is flagged). */
function pick(events) {
  const flagged = events.filter((e) => e.tier >= 1 && e.latest && e.latest.miss_distance_m != null);
  flagged.sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days);
  const out = flagged.slice(0, MAX_OBJECTS);
  const demo = Number(hash.get("demo"));
  if (demo && !out.some((e) => e.event_id === demo)) {
    const d = flagged.find((e) => e.event_id === demo);
    if (d) { out[out.length - 1] = d; out.sort((a, b) => a.latest.time_to_tca_days - b.latest.time_to_tca_days); }
  }
  return out;
}

function showError(err) {
  $("#scene").remove();
  const el = document.createElement("div");
  el.className = "load-error";
  el.innerHTML = `<p><b>Couldn't load the events.</b><br>${esc(err.message)}<br>Start the API with
    <span class="num">uv run uvicorn server:app</span> and reload.</p>`;
  document.body.append(el);
}

function start(P, icons, bg) {
  // ---------- renderer: colours are written as given (no colour management), matching the CSS tokens ----------
  THREE.ColorManagement.enabled = false;
  const canvas = $("#scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(COL.bg, 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 400);

  const keyView = new THREE.Vector3(-0.45, 0.8, 0.4).normalize(); // key light, fixed relative to the camera
  const keyWorld = new THREE.Vector3();
  // Sun: fixed in the world (illustrative direction), placed so the first Critical pass happens in daylight.
  const sunRef = P.encounters.find((e) => e.id === Number(hash.get("demo"))) || P.encounters.find((e) => e.tier >= 2) || P.encounters[0];
  const sunWorld = V(sunRef.orbit.e1).multiplyScalar(0.75).addScaledVector(V(P.own.normal), -0.65).normalize();
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  scene.add(key, key.target);

  // ---------- Earth: dark sphere, latitude hairlines only (there is no longitude in the data), soft rim ----------
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uLight: { value: keyView },
      uBase: { value: new THREE.Color(0x0a100f) },
      uLine: { value: new THREE.Color(0x2b3c37) },
      uRim: { value: new THREE.Color(0x1f4f80) },
      uMinor: { value: 1 },
      uSun: { value: sunWorld },
      uHaze: { value: new THREE.Color(0x3b78b8) },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      void main() {
        vObj = normal;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uLight; uniform vec3 uBase; uniform vec3 uLine; uniform vec3 uRim; uniform float uMinor;
      uniform vec3 uSun; uniform vec3 uHaze;
      varying vec3 vN; varying vec3 vObj; varying vec3 vV;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN); vec3 Vd = normalize(vV);
        float lat = degrees(asin(clamp(normalize(vObj).y, -1.0, 1.0)));
        float w = max(fwidth(lat), 1e-4);
        float d10 = abs(fract(lat / 10.0 + 0.5) - 0.5) * 10.0;
        float d30 = abs(fract(lat / 30.0 + 0.5) - 0.5) * 30.0;
        float fade = 1.0 - smoothstep(0.6, 3.5, w);
        float lines = (0.45 * uMinor * (1.0 - smoothstep(0.0, w * 1.1, d10)) + 0.8 * (1.0 - smoothstep(0.0, w * 1.4, d30))) * fade;
        float diff = max(dot(N, uLight), 0.0);
        float sunDot = dot(normalize(vObj), uSun);
        float day = smoothstep(-0.12, 0.3, sunDot); // soft terminator; the night side stays readable, never black
        float edge = 1.0 - max(dot(N, Vd), 0.0);
        float fres = pow(edge, 5.0);
        vec3 col = uBase * (0.55 + 0.35 * diff + 0.75 * day)
                 + uLine * lines * (0.4 + 0.3 * diff + 0.3 * day)
                 + uRim * fres * (0.12 + 0.6 * day)
                 + uHaze * pow(edge, 2.4) * day * 0.16; // faint scattering toward the limb, day side only
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither against banding
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120), earthMat));

  // Atmosphere: back-face shell; brightness from the altitude of each view ray's tangent point (thin, exaggerated).
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(0x4a8fd6) } },
    vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform vec3 uCam; uniform vec3 uSun; uniform vec3 uColor; varying vec3 vW;
      void main() {
        vec3 d = normalize(vW - uCam);
        float tca = max(-dot(uCam, d), 0.0);
        vec3 tp = uCam + d * tca;
        float h = length(tp) - 1.0;
        float g = h > 0.0 ? exp(-h / 0.008) : 0.0;
        float lit = 0.22 + 0.78 * smoothstep(-0.2, 0.4, dot(normalize(tp), uSun));
        vec3 c = uColor * g * lit * 0.8;
        c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * g;
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 160, 120), atmoMat));

  // Stars: a few faint points, far away.
  {
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      pos.set([Math.cos(a) * s * 300, z * 300, Math.sin(a) * s * 300], i * 3);
      const b = 0.18 + rnd() ** 3 * 0.55;
      col.set([b, b, b * 1.04], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
  }

  // ---------- orbits: full rings (faint, mostly for the globe) and short trails ----------
  const ringGeom = (o, n = 256) => {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(V(o.dirAt((i / n) * Math.PI * 2)).multiplyScalar(o.r));
    return new THREE.BufferGeometry().setFromPoints(pts);
  };
  const ownRing = new THREE.Line(ringGeom(P.own), new THREE.LineBasicMaterial({ color: COL.own, transparent: true, opacity: 0.3, depthWrite: false }));
  scene.add(ownRing);

  const TRAIL_STEP = (0.55 * Math.PI) / 180;
  const makeTrail = (hex, TRAIL_N = 28) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
    const c = new Float32Array(TRAIL_N * 3), base = new THREE.Color(hex);
    for (let i = 0; i < TRAIL_N; i++) { const f = (1 - i / (TRAIL_N - 1)) ** 1.6; c.set([base.r * f, base.g * f, base.b * f], i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false;
    line.userData.n = TRAIL_N;
    scene.add(line);
    return line;
  };
  const updateTrail = (line, o, tau, alpha) => {
    const a = line.geometry.attributes.position, ph = o.phase(tau);
    for (let i = 0; i < line.userData.n; i++) {
      const d = o.dirAt(ph - i * TRAIL_STEP);
      a.setXYZ(i, d[0] * o.r, d[1] * o.r, d[2] * o.r);
    }
    a.needsUpdate = true;
    line.material.opacity = alpha;
    line.visible = alpha > 0.01;
  };

  // ---------- models (static/icons.json, the same low-poly meshes as the close-approach view) ----------
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
      const idx = [];
      m.i.forEach((_, t) => idx.push(m.i[t], m.j[t], m.k[t]));
      g.setIndex(idx);
      g = g.toNonIndexed();
      g.computeVertexNormals();
    } else {
      g = new THREE.OctahedronGeometry(0.5); // icons failed to load: keep a plain shape rather than nothing
    }
    return (geomCache[name] = g);
  };
  const modelMat = (hex) => new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: 0.65, metalness: 0.1, transparent: true, side: THREE.DoubleSide });
  const own = new THREE.Mesh(geomFor("own_satellite"), modelMat(COL.own));
  own.matrixAutoUpdate = false;
  scene.add(own);
  const ownTrail = makeTrail(COL.own, 80); // ours is longer

  // Background traffic: real below-threshold events as dim specks with short trails (one draw call each layer).
  const BG_TRAIL = 10;
  const bgPos = new Float32Array(bg.length * 3);
  const bgGeom = new THREE.BufferGeometry();
  bgGeom.setAttribute("position", new THREE.BufferAttribute(bgPos, 3));
  const bgMat = new THREE.PointsMaterial({ color: 0x8a9490, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false });
  const bgPoints = new THREE.Points(bgGeom, bgMat);
  bgPoints.frustumCulled = false;
  scene.add(bgPoints);
  const bgTrailPos = new Float32Array(bg.length * (BG_TRAIL - 1) * 2 * 3);
  const bgTrailCol = new Float32Array(bgTrailPos.length);
  for (let j = 0; j < bg.length; j++) {
    for (let i = 0; i < BG_TRAIL - 1; i++) {
      const f0 = (1 - i / (BG_TRAIL - 1)) ** 1.5 * 0.32, f1 = (1 - (i + 1) / (BG_TRAIL - 1)) ** 1.5 * 0.32;
      const o = (j * (BG_TRAIL - 1) + i) * 6;
      bgTrailCol.set([f0 * 0.54, f0 * 0.58, f0 * 0.56, f1 * 0.54, f1 * 0.58, f1 * 0.56], o);
    }
  }
  const bgTrailGeom = new THREE.BufferGeometry();
  bgTrailGeom.setAttribute("position", new THREE.BufferAttribute(bgTrailPos, 3));
  bgTrailGeom.setAttribute("color", new THREE.BufferAttribute(bgTrailCol, 3));
  const bgTrails = new THREE.LineSegments(bgTrailGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  bgTrails.frustumCulled = false;
  scene.add(bgTrails);
  const bgWorld = bg.map(() => new THREE.Vector3());
  function updateBackground(tau) {
    const step = TRAIL_STEP * 1.4;
    bg.forEach((b, j) => {
      const o = b.orbit, ph = o.phase(tau);
      const d0 = o.dirAt(ph);
      bgPos.set([d0[0] * o.r, d0[1] * o.r, d0[2] * o.r], j * 3);
      bgWorld[j].set(d0[0] * o.r, d0[1] * o.r, d0[2] * o.r);
      let prev = d0;
      for (let i = 0; i < BG_TRAIL - 1; i++) {
        const d1 = o.dirAt(ph - (i + 1) * step);
        bgTrailPos.set([prev[0] * o.r, prev[1] * o.r, prev[2] * o.r, d1[0] * o.r, d1[1] * o.r, d1[2] * o.r], (j * (BG_TRAIL - 1) + i) * 6);
        prev = d1;
      }
    });
    bgGeom.attributes.position.needsUpdate = true;
    bgTrailGeom.attributes.position.needsUpdate = true;
  }

  // Rings: one canvas-drawn circle, screen-sized sprites in the tier colour.
  const ringTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d"); x.strokeStyle = "#fff"; x.lineWidth = 5; x.beginPath(); x.arc(64, 64, 56, 0, Math.PI * 2); x.stroke();
    return new THREE.CanvasTexture(c);
  })();
  const sprite = (hex) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: hex, transparent: true, depthWrite: false, sizeAttenuation: false }));
    s.visible = false; scene.add(s); return s;
  };

  const objs = P.encounters.map((enc) => {
    const mesh = new THREE.Mesh(geomFor(enc.type), modelMat(COL.grey));
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    const ring = new THREE.Line(ringGeom(enc.orbit, 192), new THREE.LineBasicMaterial({ color: 0x5d6965, transparent: true, opacity: 0, depthWrite: false }));
    scene.add(ring);
    const hex = TIER_HEX[enc.tier] || COL.elev;
    return { enc, mesh, ring, trail: makeTrail(0x8d9692), flag: sprite(hex), pulse: sprite(hex), pos: new THREE.Vector3() };
  });

  // ---------- time ----------
  const slider = $("#time"), playBtn = $("#play"), readout = $("#readout");
  slider.max = P.endS.toFixed(2);
  $("#ticks").innerHTML = P.encounters.map((e) =>
    `<span style="left:${((e.tcaS / P.endS) * 100).toFixed(2)}%;--c:${e.tier >= 2 ? "var(--crit)" : "var(--elev)"}" title="EVT ${e.id}"></span>`).join("");
  $("#scale").innerHTML = `Our orbit ${Math.round(P.altKm)} km (median target altitude)<br>×${SPEED} speed · miss ×${MISS_SCALE} · models not to scale`;

  let s = 0, playing = !reduced;
  const demo = P.encounters.find((e) => e.id === Number(hash.get("demo")));
  if (demo) { s = Math.max(0, demo.tcaS - 1.2); playing = false; }
  else if (hash.has("t")) s = clamp(Number(hash.get("t")) || 0, 0, P.endS);
  else if (reduced) { const c = P.encounters.find((e) => e.tier >= 2) || P.encounters[0]; s = Math.max(0, c.tcaS - 1.2); }

  const setPlaying = (p) => {
    playing = p;
    playBtn.setAttribute("aria-pressed", String(p));
    playBtn.setAttribute("aria-label", p ? "Pause replay" : "Play replay");
  };
  setPlaying(playing);
  playBtn.addEventListener("click", () => { if (!playing && s >= P.endS - 0.01) s = 0; setPlaying(!playing); });
  slider.addEventListener("input", () => { s = Number(slider.value); });
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLAnchorElement)) {
      e.preventDefault(); setPlaying(!playing);
    }
  });

  // ---------- camera: zoom blends HORIZON (0) to GLOBE (1); drag orbits a little around the look-at point ----------
  let zoom = hash.get("view") === "globe" ? 1 : 0, zoomTarget = zoom, yaw = 0, pitch = 0;
  const viewBtns = [...document.querySelectorAll(".views button")];
  const syncViewBtns = () => viewBtns.forEach((b) => b.setAttribute("aria-pressed", String((zoomTarget >= 0.5 ? 1 : 0) === Number(b.dataset.view))));
  viewBtns.forEach((b) => b.addEventListener("click", () => { zoomTarget = Number(b.dataset.view); yaw *= 0.3; pitch *= 0.3; syncViewBtns(); }));
  syncViewBtns();
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomTarget = clamp(zoomTarget + e.deltaY * 0.0011, 0, 1); syncViewBtns(); }, { passive: false });
  const pointers = new Map();
  let pinch0 = 0;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); canvas.classList.add("dragging"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const [px, py] = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0) { zoomTarget = clamp(zoomTarget - Math.log(d / pinch0) * 0.9, 0, 1); syncViewBtns(); }
      pinch0 = d;
      return;
    }
    const lim = lerp(0.55, 1.3, zoom);
    yaw = clamp(yaw - ((e.clientX - px) / innerWidth) * 2.2, -lim, lim);
    pitch = clamp(pitch + ((e.clientY - py) / innerHeight) * 1.6, -lim * 0.5, lim * 0.5);
  });
  const up = (e) => { pointers.delete(e.pointerId); pinch0 = 0; if (!pointers.size) canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // ---------- jumping: Next passes and the flag log both move the replay (and camera) to a flag ----------
  function jumpTo(enc, pause) {
    s = Math.max(0, enc.tcaS - 1.2);
    zoomTarget = 0; yaw = 0; pitch = 0; syncViewBtns();
    if (pause) setPlaying(false);
  }
  const byId = new Map(P.encounters.map((e) => [e.id, e]));
  const tierVar = (t) => (t >= 2 ? "var(--crit)" : "var(--elev)");
  const nextEl = $("#next"), logEl = $("#log");
  let nextKey = "", logKey = "";
  const row = (e, right) =>
    `<li><button type="button" data-id="${e.id}"><span class="tdot" style="--c:${tierVar(e.tier)}" aria-hidden="true"></span>EVT ${e.id}<span class="t">${right}</span></button></li>`;
  nextEl.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) jumpTo(byId.get(Number(b.dataset.id)), false); });
  logEl.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) jumpTo(byId.get(Number(b.dataset.id)), true); });
  const mins = (e) => Math.max(0, Math.round(((e.tcaS - s) * SPEED) / 60));
  function updatePanels() {
    const upcoming = P.encounters.filter((e) => e.tcaS > s).slice(0, 3);
    const nk = upcoming.map((e) => `${e.id}:${mins(e)}`).join();
    if (nk !== nextKey) {
      nextKey = nk;
      nextEl.innerHTML = upcoming.length
        ? upcoming.map((e) => row(e, `${TIER_NAME[e.tier]} · in ${mins(e)} min`)).join("")
        : `<li class="empty">No more passes in this replay</li>`;
    }
    const flagged = P.encounters.filter((e) => s >= e.tcaS - WARN_BEFORE_S).slice(-3).reverse();
    const lk = flagged.map((e) => e.id).join();
    if (lk !== logKey) {
      logKey = lk;
      logEl.innerHTML = flagged.length
        ? flagged.map((e) => row(e, `${TIER_NAME[e.tier]} · ${fmtDist(e.event.latest.miss_distance_m)}`)).join("")
        : `<li class="empty">No flags yet</li>`;
    }
  }

  // ---------- hover tooltip + our satellite's label ----------
  const tip = $("#tip"), ownLabel = $("#own-label"), countsEl = $("#counts");
  ownLabel.textContent = `Our satellite · ${Math.round(P.altKm)} km`;
  let mouse = null;
  canvas.addEventListener("pointermove", (e) => { mouse = pointers.size ? null : [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerleave", () => { mouse = null; });
  const isOccluded = (pos) => {
    const d = tmp.b.copy(pos).sub(camera.position);
    const k = clamp(-camera.position.dot(d) / d.lengthSq(), 0, 1);
    return tmp.c.copy(camera.position).addScaledVector(d, k).length() < 1;
  };
  const toScreen = (pos) => {
    const p = tmp.a.copy(pos).project(camera);
    if (p.z >= 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05 || isOccluded(pos)) return null;
    return [(p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight];
  };
  function updateHover(ownPos) {
    if (!mouse) { tip.hidden = true; canvas.style.cursor = ""; return; }
    let best = null, bd = 14 * 14;
    const consider = (pos, html) => {
      const sp = toScreen(pos);
      if (!sp) return;
      const d = (sp[0] - mouse[0]) ** 2 + (sp[1] - mouse[1]) ** 2;
      if (d < bd) { bd = d; best = html; }
    };
    bg.forEach((b, j) => consider(bgWorld[j], `EVT ${b.id} <span class="m">· ${esc(typeLabel(b.type))} · below threshold</span>`));
    for (const o of objs) if (o.mesh.visible) consider(o.pos, `EVT ${o.enc.id} <span class="m">· ${esc(typeLabel(o.enc.type))} ·</span> <span class="${o.enc.tier >= 2 ? "c" : "e"}">${TIER_NAME[o.enc.tier]}</span>`);
    consider(ownPos, `<span class="o">Our satellite</span> <span class="m">· ${Math.round(P.altKm)} km</span>`);
    tip.hidden = !best;
    canvas.style.cursor = best ? "pointer" : "";
    if (best) {
      tip.innerHTML = best;
      const x = Math.min(mouse[0] + 14, innerWidth - tip.offsetWidth - 8), y = Math.max(8, mouse[1] - 30);
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }
  let countsKey = "";
  function updateCounts(tau) {
    let c = 0, e = 0;
    for (const o of objs) if (visibility(o.enc, tau) > 0.5) o.enc.tier >= 2 ? c++ : e++;
    const k = `${c}/${e}`;
    if (k === countsKey) return;
    countsKey = k;
    countsEl.innerHTML = `Passing now: <b class="${c ? "c" : ""}">${c} Critical</b> · <b class="${e ? "e" : ""}">${e} Elevated</b> · <b class="z">${bg.length}</b> below threshold`;
  }

  const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4() };
  function placeCamera(tau) {
    const p = V(P.own.pos(tau)), U = p.clone().normalize(), t = V(P.own.vel(tau)), h = V(P.own.normal);
    // HORIZON: just above the orbit, off to the side, looking ahead along the limb.
    const camH = p.clone().addScaledVector(U, 0.028).addScaledVector(h, -0.12).addScaledVector(t, -0.075);
    const tgtH = p.clone().addScaledVector(t, 0.06).addScaledVector(U, -0.03);
    const z = ease(zoom);
    // GLOBE: the same camera pulled back, kept on our satellite's side of the planet.
    const globeDir = h.clone().multiplyScalar(-0.62).addScaledVector(U, 0.7).add(new THREE.Vector3(0, 0.2, 0)).normalize();
    const rH = camH.length(), rG = 6.2;
    const dir = tmp.a.copy(camH).normalize();
    const ang = dir.angleTo(globeDir);
    const axis = tmp.b.crossVectors(dir, globeDir).normalize();
    if (ang > 1e-4 && axis.lengthSq() > 0) dir.applyAxisAngle(axis, ang * z);
    const pos = dir.multiplyScalar(Math.exp(lerp(Math.log(rH), Math.log(rG), z)));
    const tgt = tgtH.multiplyScalar(1 - ease(Math.min(1, zoom * 1.25)));
    const upv = U.clone().lerp(new THREE.Vector3(0, 1, 0), z).normalize();
    // drag offset: orbit the camera around the look-at point
    const off = pos.clone().sub(tgt);
    off.applyAxisAngle(upv, yaw);
    const right = tmp.c.crossVectors(off, upv).normalize();
    off.applyAxisAngle(right, pitch);
    pos.copy(tgt).add(off);
    if (pos.length() < 1.015) pos.setLength(1.015);
    camera.position.copy(pos);
    camera.up.copy(upv);
    camera.lookAt(tgt);
    camera.fov = lerp(42, 30, z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // Orient a model: local x along travel, local z radial up (rocket bodies lie along travel instead).
  function placeModel(mesh, pos, vel, size, type, spin) {
    const zU = tmp.a.copy(pos).normalize(), xT = tmp.b.copy(vel).normalize(), yN = tmp.c.crossVectors(zU, xT).normalize();
    if (type === "rocket_body") mesh.matrix.makeBasis(zU, yN, xT);
    else mesh.matrix.makeBasis(xT, yN, zU);
    if (spin) mesh.matrix.multiply(tmp.m.makeRotationFromEuler(new THREE.Euler(spin * 0.7, spin, spin * 0.4)));
    mesh.matrix.scale(new THREE.Vector3(size, size, size)).setPosition(pos);
    mesh.matrixWorldNeedsUpdate = true;
  }

  // ---------- flag + callout ----------
  const callout = $("#callout"), leader = $("#leader line");
  let active = null, activeSince = 0;
  function setActive(o, now) {
    if (o === active) return;
    active = o;
    activeSince = now;
    if (!o) { callout.hidden = true; leader.parentElement.style.display = "none"; return; }
    const e = o.enc.event, L = e.latest;
    callout.dataset.tier = String(e.tier);
    callout.style.setProperty("--c", e.tier >= 2 ? "var(--crit)" : "var(--elev)");
    leader.parentElement.style.setProperty("--c", e.tier >= 2 ? "var(--crit)" : "var(--elev)");
    callout.innerHTML = `
      <div class="l1"><b>EVT ${e.event_id}</b> · ${esc(typeLabel(o.enc.type))} · ${fmtDist(L.miss_distance_m)} · TCA ${L.time_to_tca_days.toFixed(2)} d</div>
      <div class="l2">${TIER_NAME[e.tier]} (${esc(titleCase(e.action && e.action.queue))}) <span class="muted">·</span> ${basis(e)}</div>
      <a href="/static/review.html#event=${e.event_id}">Open decision record</a>`;
    callout.hidden = false;
    // restart the entrance animation
    callout.style.animation = "none"; void callout.offsetWidth; callout.style.animation = "";
  }
  function positionCallout() {
    if (!active) return;
    const p = tmp.a.copy(active.pos).project(camera);
    const W = innerWidth, H = innerHeight;
    // hidden behind the Earth? (closest point of the camera-to-object segment inside the sphere)
    const d = tmp.b.copy(active.pos).sub(camera.position);
    const k = clamp(-camera.position.dot(d) / d.lengthSq(), 0, 1);
    const occluded = tmp.c.copy(camera.position).addScaledVector(d, k).length() < 1;
    const onScreen = !occluded && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    const x = (p.x * 0.5 + 0.5) * W, y = (-p.y * 0.5 + 0.5) * H;
    const cw = callout.offsetWidth, ch = callout.offsetHeight, gap = 44;
    let left = x + gap, top = y - gap - ch;
    if (left + cw > W - 16) left = x - gap - cw;
    if (top < 64) top = y + gap;
    left = clamp(left, 16, W - cw - 16);
    top = clamp(top, 64, H - ch - 170);
    callout.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    const svg = leader.parentElement;
    svg.style.display = onScreen ? "" : "none";
    if (onScreen) {
      const ax = left > x ? left : left + cw, ay = top > y ? top : top + ch;
      const dx = ax - x, dy = ay - y, d = Math.hypot(dx, dy) || 1, r0 = 16; // start just outside the ring
      leader.setAttribute("x1", (x + (dx / d) * r0).toFixed(1)); leader.setAttribute("y1", (y + (dy / d) * r0).toFixed(1));
      leader.setAttribute("x2", ax.toFixed(1)); leader.setAttribute("y2", ay.toFixed(1));
    }
  }

  // ---------- loop ----------
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing) {
      s += dt;
      if (s > P.endS) {
        s = 0;
        if (!reduced) { canvas.classList.add("dip"); setTimeout(() => canvas.classList.remove("dip"), 220); }
      }
    }
    if (document.activeElement !== slider) slider.value = s.toFixed(2);
    const tau = s * SPEED;
    readout.innerHTML = `<b>+${Math.round(tau / 60)}</b> MIN SIMULATED`;

    zoom = reduced ? zoomTarget : zoom + (zoomTarget - zoom) * (1 - Math.exp(-dt * 3));
    if (Math.abs(zoom - zoomTarget) < 1e-3) zoom = zoomTarget;
    placeCamera(tau);
    const z = ease(zoom);
    keyWorld.copy(keyView).transformDirection(camera.matrixWorld);
    key.position.copy(keyWorld).multiplyScalar(10);
    atmoMat.uniforms.uCam.value.copy(camera.position);
    atmoMat.uniforms.uSun.value.copy(sunWorld);

    const size = lerp(0.0045, 0.075, z);
    earthMat.uniforms.uMinor.value = 1 - z;
    const ownPos = V(P.own.pos(tau));
    placeModel(own, ownPos, V(P.own.vel(tau)), size * 1.25, "own_satellite", 0);
    updateBackground(tau);
    bgMat.opacity = lerp(0.75, 0.6, z);
    bgTrails.material.opacity = lerp(1, 0.6, z);
    updateTrail(ownTrail, P.own, tau, lerp(0.9, 0.5, z));
    ownRing.material.opacity = lerp(0.22, 0.4, z);

    // active flag: the one in its warning window (windows never overlap: encounters are >= 6 s apart)
    let next = null;
    for (const o of objs) {
      const e = o.enc, vis = visibility(e, tau);
      o.pos.copy(V(e.orbit.pos(tau)));
      o.mesh.visible = vis > 0.01;
      o.mesh.material.opacity = vis;
      if (o.mesh.visible) placeModel(o.mesh, o.pos, V(e.orbit.vel(tau)), size, e.type, e.type === "debris" || e.type === "unknown" ? s * 0.9 + e.id : 0);
      updateTrail(o.trail, e.orbit, tau, vis * lerp(0.75, 0.35, z));
      o.ring.material.opacity = vis * 0.22 * z;
      o.ring.visible = o.ring.material.opacity > 0.005;
      const dtca = s - e.tcaS;
      if (dtca >= -WARN_BEFORE_S && dtca <= WARN_AFTER_S && vis > 0.5) next = o;
    }
    setActive(next, now);

    for (const o of objs) {
      const isActive = o === active, e = o.enc;
      const upcoming = s < e.tcaS && visibility(e, tau) > 0.5;
      const quiet = upcoming && !isActive ? 0.4 * z : 0; // globe only: the other flagged objects get a faint ring
      o.flag.visible = isActive || quiet > 0.01;
      if (o.flag.visible) {
        o.flag.position.copy(o.pos);
        const k = isActive ? 0.042 : 0.026;
        o.flag.scale.set(k, k, 1);
        o.flag.material.opacity = isActive ? 1 : quiet;
      }
      // restrained 2-pulse when the flag turns on
      const age = (now - activeSince) / 1000;
      const pulseOn = isActive && !reduced && age < 1.5;
      o.pulse.visible = pulseOn;
      if (pulseOn) {
        const ph = (age % 0.75) / 0.75;
        const k = 0.042 * (1 + ph * 1.4);
        o.pulse.position.copy(o.pos);
        o.pulse.scale.set(k, k, 1);
        o.pulse.material.opacity = (1 - ph) * 0.7;
      }
    }

    renderer.render(scene, camera);
    positionCallout();
    updatePanels();
    updateCounts(tau);
    updateHover(ownPos);
    const sp = toScreen(ownPos);
    let showLabel = !!sp;
    if (sp) {
      const lw = ownLabel.offsetWidth, lx = sp[0] - lw / 2, ly = sp[1] + 18;
      if (active && !callout.hidden) { // never let the label slide under the callout
        const r = callout.getBoundingClientRect();
        if (lx < r.right + 8 && lx + lw > r.left - 8 && ly < r.bottom + 8 && ly + 16 > r.top - 8) showLabel = false;
      }
      ownLabel.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    }
    ownLabel.style.display = showLabel ? "" : "none";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
