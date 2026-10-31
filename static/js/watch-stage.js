// Watch stage: our satellite at the centre, encounters drifting in as blips (canvas 2D, no library).
// Geometry is illustrative and says so on screen: a blip's bearing comes from the CDM relative position (radial up,
// normal across); its distance from the centre is its predicted miss distance plus a term that shrinks as the replay
// clock nears its closest approach, so every blip settles at its miss distance exactly at TCA. Nothing is to scale.
// No tinted zones or bands: the 1 km and 5 km thresholds are single hairlines.
import { clamp } from "./fmt.js";

const C = {
  bg: "#080a0b", ink: "#e6ebe8", muted: "#7d8a85", faint: "#56625e", hair: "#1b2220", hair2: "#2a3532",
  below: "#8a9490", elev: "#e8a33c", crit: "#ff4a3d", own: "#5ea9ff", obj: "#aebfcf",
};
const MONO = '"Spline Sans Mono", ui-monospace, Menlo, monospace';
export const R_SAT = 0.075, R1 = 0.24, R5 = 0.42, APPROACH = 0.95, HORIZON = 7, BEZEL = 1.0;
const PULSE_MS = 800, PULSES = 3, ZOOM_MS = 1100, QUEUE_PAD = 380;

// Stage radius (units of the stage half-size) for a miss distance: linear inside 1 km, log beyond.
export function missRadius(m) {
  if (m <= 1000) return R_SAT + ((R1 - R_SAT) * Math.max(0, m)) / 1000;
  return R1 + ((R5 - R1) * Math.log10(m / 1000)) / Math.log10(5);
}
// Bearing from the CDM relative position: radial is "up", normal is "across" (looking along-track).
function bearing(e) {
  const [r, t, n] = e.latest.relative_position_rtn_m;
  if (Math.hypot(r, n) < 1e-6) return t >= 0 ? 0 : Math.PI;
  return Math.atan2(r, n);
}
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

export function createStage(canvas, { remaining, isAcked, onPick, onHover }) {
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let W = 0, H = 0, dpr = 1, S = 1;
  let events = [], dirs = []; // [cos, sin] per event, precomputed
  let focus = null; // { event, t0 }
  let inset = 0; // px covered by the side box on the right
  let zoom = { from: 0, to: 0, t0: 0 }; // focus amount 0 (calm) -> 1 (zoomed on the encounter)
  let raf = 0;
  const hits = []; // [x, y, index] of drawn blips this frame, for hover and click

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    S = (Math.min(W, H) / 2) * 0.9;
    draw();
  }
  new ResizeObserver(resize).observe(canvas);

  const zoomAmount = (now) => {
    if (reduced.matches) return zoom.to;
    const t = clamp((now - zoom.t0) / ZOOM_MS, 0, 1);
    return zoom.from + (zoom.to - zoom.from) * easeOutExpo(t);
  };
  const worldPos = (i, rem) => {
    const e = events[i];
    const rho = missRadius(e.latest.miss_distance_m) + (APPROACH * clamp(rem, 0, HORIZON)) / HORIZON;
    return [dirs[i][0] * rho, -dirs[i][1] * rho];
  };

  // Camera: calm = centred on the satellite at 1x; focused = on the satellite-object midpoint, zoomed so the pair
  // fills the part of the stage the side box leaves open.
  function camera(now) {
    const a = zoomAmount(now);
    const calm = { x: 0, y: 0, k: 1, cx: W / 2 };
    if (!focus || a === 0) return { ...calm, a };
    const i = events.indexOf(focus.event);
    // Zoom on the predicted closest approach: the object at its miss distance, where the rings mean something.
    const [px, py] = i >= 0 ? worldPos(i, 0) : [0, 0];
    let left = 0;
    const right = inset > 0 && inset < W * 0.8 ? W - inset : W;
    if (right - QUEUE_PAD > 420) left = QUEUE_PAD; // keep the pair clear of the queue on the left
    const open = right - left;
    const dist = Math.max(Math.hypot(px, py), 0.05);
    const k = clamp((0.34 * Math.min(open, H)) / (dist * S), 1.3, 5);
    const f = { x: px / 2, y: py / 2, k, cx: left + open / 2 };
    const L = (p, q) => p + (q - p) * a;
    return { x: L(calm.x, f.x), y: L(calm.y, f.y), k: L(calm.k, f.k), cx: L(calm.cx, f.cx), a };
  }

  function draw() {
    raf = 0;
    if (!W || !H) return;
    const now = performance.now();
    const cam = camera(now);
    const toX = (x) => cam.cx + (x - cam.x) * cam.k * S;
    const toY = (y) => H / 2 + (y - cam.y) * cam.k * S;
    const unit = cam.k * S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const ox = toX(0), oy = toY(0);

    // Decorative bezel (not an orbit: there is no orbit data). Ticks every 5 degrees, longer every 30.
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.hair;
    ctx.beginPath(); ctx.arc(ox, oy, BEZEL * unit, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (let d = 0; d < 360; d += 5) {
      const th = (d * Math.PI) / 180, long = d % 30 === 0, r0 = BEZEL * unit, r1 = r0 + (long ? 9 : 4);
      ctx.moveTo(ox + Math.cos(th) * r0, oy + Math.sin(th) * r0);
      ctx.lineTo(ox + Math.cos(th) * r1, oy + Math.sin(th) * r1);
    }
    ctx.strokeStyle = C.hair2; ctx.stroke();
    ctx.font = `10px ${MONO}`; ctx.fillStyle = C.faint; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("R", ox, oy - BEZEL * unit - 18);
    ctx.fillText("N", ox + BEZEL * unit + 20, oy);

    // Threshold hairlines at 1 km and 5 km (at closest approach). The 1 km line turns red only during an alert.
    const alertA = focus ? cam.a : 0;
    for (const [r, label] of [[R1, "1 KM"], [R5, "5 KM"]]) {
      ctx.beginPath(); ctx.arc(ox, oy, r * unit, 0, Math.PI * 2);
      ctx.strokeStyle = r === R1 && alertA > 0.01 ? `rgba(255,74,61,${0.25 + 0.45 * alertA})` : C.hair2;
      ctx.stroke();
      const th = -Math.PI * 0.32;
      const lx = ox + Math.cos(th) * r * unit, ly = oy + Math.sin(th) * r * unit;
      ctx.fillStyle = C.bg; ctx.fillRect(lx - 17, ly - 7, 34, 14);
      ctx.fillStyle = r === R1 && alertA > 0.01 ? C.crit : C.muted;
      ctx.fillText(label, lx, ly);
    }

    // Blips. Below threshold: faint specks. Elevated: amber. Critical: red; hollow once acknowledged.
    hits.length = 0;
    const dim = focus ? 1 - 0.7 * cam.a : 1;
    const tail = 10 + 6 * Math.sqrt(cam.k - 1);
    const visible = (x, y) => x > -20 && x < W + 20 && y > -20 && y < H + 20;
    for (const tier of [0, 1, 2]) {
      ctx.beginPath();
      const tails = new Path2D();
      const ringsAck = new Path2D();
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.tier !== tier || (focus && focus.event === e)) continue;
        const rem = remaining(e);
        if (rem < -0.2) continue; // passed closest approach: gone
        const [wx, wy] = worldPos(i, rem);
        const x = toX(wx), y = toY(wy);
        if (!visible(x, y)) continue;
        hits.push(x, y, i);
        if (tier === 0) { ctx.rect(x - 0.75, y - 0.75, 1.5, 1.5); continue; }
        if (rem > 0) {
          tails.moveTo(x + dirs[i][0] * 3, y - dirs[i][1] * 3);
          tails.lineTo(x + dirs[i][0] * tail, y - dirs[i][1] * tail);
        }
        if (tier === 2 && isAcked(e.event_id)) { ringsAck.moveTo(x + 3.5, y); ringsAck.arc(x, y, 3.5, 0, Math.PI * 2); continue; }
        const s = tier === 2 ? 2.4 : 2.1;
        ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, Math.PI * 2);
      }
      const col = [C.below, C.elev, C.crit][tier];
      ctx.globalAlpha = (tier === 0 ? 0.22 : tier === 1 ? 0.8 : 0.75) * dim;
      ctx.fillStyle = col; ctx.fill();
      if (tier > 0) {
        ctx.globalAlpha = 0.22 * dim; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke(tails);
        ctx.globalAlpha = 0.9 * dim; ctx.lineWidth = 1.25; ctx.stroke(ringsAck);
      }
      ctx.globalAlpha = 1;
    }

    // Our satellite: the hero. Body and two panels, drawn, in blue.
    const s = 13 * Math.sqrt(cam.k);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = C.own;
    ctx.fillRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-s * 2.9, -s * 0.38, s * 1.75, s * 0.76);
    ctx.fillRect(s * 1.15, -s * 0.38, s * 1.75, s * 0.76);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.own; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-s * 1.15, 0); ctx.lineTo(-s * 0.55, 0); ctx.moveTo(s * 0.55, 0); ctx.lineTo(s * 1.15, 0); ctx.stroke();
    ctx.strokeStyle = C.bg; ctx.lineWidth = 1;
    for (const x0 of [-s * 2.9, s * 1.15]) for (let j = 1; j < 3; j++) {
      ctx.beginPath(); ctx.moveTo(x0 + (s * 1.75 * j) / 3, -s * 0.38); ctx.lineTo(x0 + (s * 1.75 * j) / 3, s * 0.38); ctx.stroke();
    }
    ctx.restore();
    ctx.font = `500 10px ${MONO}`; ctx.fillStyle = C.own; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("OUR SATELLITE", ox, oy + s + 10);

    // The encounter under alert: object, the line between, and a restrained 3-pulse ring that then holds.
    let more = !reduced.matches && zoom.t0 && now - zoom.t0 < ZOOM_MS;
    if (focus) {
      const i = events.indexOf(focus.event);
      // glides in from its replay position to its predicted closest approach as the camera closes in
      const rem = Math.max(0, remaining(focus.event)) * (1 - cam.a);
      const [wx, wy] = worldPos(i, rem);
      const x = toX(wx), y = toY(wy);
      ctx.globalAlpha = cam.a;
      ctx.setLineDash([3, 4]); ctx.strokeStyle = C.crit; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      drawObject(ctx, focus.event.latest.object_type, x, y, 6 * Math.sqrt(cam.k));
      const t = now - focus.t0;
      if (!reduced.matches && t < PULSE_MS * PULSES) {
        more = true;
        for (let p = 0; p < PULSES; p++) {
          const ph = (t - p * PULSE_MS) / PULSE_MS;
          if (ph < 0 || ph > 1) continue;
          ctx.globalAlpha = (1 - ph) * 0.9;
          ctx.strokeStyle = C.crit; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 12 + 38 * easeOutExpo(ph), 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = C.crit; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke();
      // Label on the side away from the satellite, unless that runs under the side box.
      const L = focus.event.latest;
      ctx.font = `600 12px ${MONO}`;
      const lw = Math.max(ctx.measureText(`${L.object_type} · EVENT ${focus.event.event_id}`).width, 200);
      const edge = W - (inset > 0 && inset < W * 0.8 ? inset : 0) - 12;
      const right = x >= ox ? x + 24 + lw < edge : x - 24 - lw < 12;
      ctx.textAlign = right ? "left" : "right"; ctx.textBaseline = "alphabetic";
      const lx = x + (right ? 24 : -24);
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = C.ink;
      ctx.fillText(`${L.object_type} · EVENT ${focus.event.event_id}`, lx, y - 4);
      ctx.font = `11px ${MONO}`; ctx.fillStyle = C.muted;
      ctx.fillText(`${fmtM(L.miss_distance_m)} at closest approach`, lx, y + 12);
      ctx.fillStyle = C.faint;
      ctx.fillText("illustrative position", lx, y + 27);
    }
    if (more) raf = requestAnimationFrame(draw);
  }

  function requestDraw() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function pick(mx, my) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < hits.length; j += 3) {
      const e = events[hits[j + 2]], d = Math.hypot(hits[j] - mx, hits[j + 1] - my);
      const reach = e.tier === 0 ? 5 : 9;
      // prefer higher tiers when blips overlap
      const score = d - e.tier * 3;
      if (d <= reach && score < bd) { bd = score; best = hits[j + 2]; }
    }
    return best >= 0 ? events[best] : null;
  }
  const local = (ev) => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  canvas.addEventListener("mousemove", (ev) => {
    const [x, y] = local(ev), e = pick(x, y);
    canvas.classList.toggle("hot", !!e && e.tier === 2);
    onHover(e, x, y);
  });
  canvas.addEventListener("mouseleave", () => onHover(null));
  canvas.addEventListener("click", (ev) => {
    const e = pick(...local(ev));
    if (e) onPick(e);
  });
  reduced.addEventListener?.("change", requestDraw);
  document.fonts?.ready.then(requestDraw);

  return {
    setEvents(list) {
      events = list;
      dirs = list.map((e) => { const b = bearing(e); return [Math.cos(b), Math.sin(b)]; });
      requestDraw();
    },
    setInset(px) { inset = px; requestDraw(); },
    focus(event) {
      const now = performance.now();
      const a = zoomAmount(now);
      focus = { event, t0: now };
      zoom = { from: a, to: 1, t0: now };
      requestDraw();
    },
    unfocus() {
      const now = performance.now();
      zoom = { from: zoomAmount(now), to: 0, t0: now };
      // keep drawing the object while zooming out, then drop it
      const ev = focus?.event;
      setTimeout(() => { if (focus?.event === ev && zoom.to === 0) { focus = null; requestDraw(); } }, reduced.matches ? 0 : ZOOM_MS);
      requestDraw();
    },
    requestDraw,
  };
}

const fmtM = (m) => (m < 10_000 ? `${Math.round(m).toLocaleString("en")} m` : `${(m / 1000).toFixed(1)} km`);

// The offending object, in the side box's neutral object colour; shape by catalogue type.
function drawObject(ctx, type, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = C.obj;
  ctx.beginPath();
  if (type === "DEBRIS") {
    const pts = [[1, -0.2], [0.45, 0.85], [-0.55, 0.7], [-1, -0.1], [-0.3, -0.95], [0.6, -0.8]];
    pts.forEach(([px, py], j) => (j ? ctx.lineTo(px * s, py * s) : ctx.moveTo(px * s, py * s)));
    ctx.closePath();
  } else if (type === "PAYLOAD") {
    ctx.rect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2);
    ctx.rect(-s * 2, -s * 0.3, s * 1.2, s * 0.6);
    ctx.rect(s * 0.8, -s * 0.3, s * 1.2, s * 0.6);
  } else if (type === "ROCKET BODY") {
    ctx.rect(-s * 1.4, -s * 0.45, s * 2.4, s * 0.9);
    ctx.moveTo(s, -s * 0.45); ctx.lineTo(s * 1.6, 0); ctx.lineTo(s, s * 0.45);
  } else {
    ctx.arc(0, 0, s * 0.8, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}
