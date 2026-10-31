// Close-approach views for the dashboard (owner: Integration & trust).
// Needs Plotly on the page: <script src="/static/vendor/plotly-3.1.0.min.js"></script> (vendored copy of cdnjs 3.1.0)
//
//   CloseApproach.render3d(el, event)      geometry at TCA for one event (event shape: docs/CONTRACT.md §2)
//   CloseApproach.renderCompare(el, events) up to 3 events: miss distance and Pc upper bound over the updates
//   CloseApproach.theme(colors)            optional: adopt the host page's tier/surface colours
//
// Both take the event objects exactly as /api/events/{id} returns them; nothing is recomputed here
// except unit conversion. The tier always comes from the pipeline.
(() => {
  const C = {
    text: "#e6e8ee",
    muted: "#8a90a0",
    grid: "#2a2f3a",
    surface: "#171a21",
    critical: "#d03b3b", // status palette: thresholds and tiers, never reused for series
    warning: "#fab219",
    below: "#8a90a0", // tier 0 is "below threshold" - neutral, never a "good" green
    series: ["#3987e5", "#d95926", "#199e70"], // dark categorical slots 1-3, validated all-pairs on #171a21
  };
  const TIER = [
    { color: C.below, icon: "○", name: "Below threshold" },
    { color: C.warning, icon: "▲", name: "Elevated" },
    { color: C.critical, icon: "■", name: "Critical" },
  ];
  const CRITICAL_KM = 1, ELEVATED_KM = 5;
  const SIGMA_SENTINEL_M = 1e7; // dataset placeholder for unusable sigmas is ~63,781 km (triage/features.py)
  const MAX_COMPARE = C.series.length;
  const CAUTION_TEXT = {
    needs_review: "Needs review",
    pc_diluted: "Pc may be diluted by uncertainty",
    no_covariance: "No usable position uncertainty",
  };
  const config = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["toImage"] };
  // Low-poly object icons (scripts/build_icons.py -> static/icons.json). Optional: if they fail to load, the plain
  // markers stay. Icons are drawn ENLARGED at the objects' true relative positions; only the positions are to scale.
  const OWN_COLOR = "#5ea9ff", OBJECT_COLOR = "#aebfcf";
  const ICON_FOR = { DEBRIS: "debris", PAYLOAD: "payload", "ROCKET BODY": "rocket_body" };
  const ICONS = fetch("/static/icons.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  function iconMesh(m, [cx, cy, cz], size, color, opacity, name) {
    return {
      type: "mesh3d", name, x: m.x.map((v) => cx + v * size), y: m.y.map((v) => cy + v * size), z: m.z.map((v) => cz + v * size),
      i: m.i, j: m.j, k: m.k, color, opacity, flatshading: true, showlegend: false, hovertemplate: `${name}<extra></extra>`,
      lighting: { ambient: 0.55, diffuse: 0.8, specular: 0.15, roughness: 0.6 }, lightposition: { x: 100, y: 200, z: 300 },
    };
  }
  const font = { family: "ui-sans-serif, system-ui, sans-serif", size: 12, color: C.text };

  const km = (m) => m / 1000;
  const fmtDist = (m) => (m < 10_000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(1)} km`);
  const fmtKm = (v) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0));
  const fmtPc = (log10) => `1e${log10.toFixed(1)}`;
  const UNKNOWN = '<span class="ca-unknown" title="not in the data">—</span>';
  // Plain-English position of the miss distance against the two distance lines.
  const distanceLine = (m) =>
    m < CRITICAL_KM * 1000 ? "inside the 1 km critical line"
      : m <= ELEVATED_KM * 1000 ? "inside the 5 km elevated line"
        : "outside both distance lines";
  const reading = (label, value, sub = "") =>
    `<div class="ca-reading"><span class="ca-label">${label}</span><span class="ca-value">${value}</span>${sub ? `<span class="ca-sub">${sub}</span>` : ""}</div>`;
  function trend(e) {
    const h = e.history;
    if (!h || h.length < 2) return '<span class="ca-muted">one update</span>';
    const a = h[0].miss_distance_m, b = h[h.length - 1].miss_distance_m;
    const word = b < a ? "closing" : b > a ? "opening" : "steady";
    return `${word} <span class="ca-muted">${fmtDist(a)} → ${fmtDist(b)}</span>`;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function cautionBadges(event) {
    const codes = event.cautions || (event.needs_review ? ["needs_review"] : []);
    return codes.map((c) => `<span class="ca-caution">⚠ ${esc(CAUTION_TEXT[c] || c)}</span>`).join(" ");
  }

  function tierBadge(tier) {
    const t = TIER[tier];
    return `<span class="ca-tier" style="border-color:${t.color}"><span style="color:${t.color}">${t.icon}</span> ${t.name}</span>`;
  }

  function sphere(radiusKm, color, opacity, name) {
    const n = 24, x = [], y = [], z = [];
    for (let i = 0; i <= n; i++) {
      const th = (Math.PI * i) / n, rx = [], ry = [], rz = [];
      for (let j = 0; j <= n; j++) {
        const ph = (2 * Math.PI * j) / n;
        rx.push(radiusKm * Math.sin(th) * Math.cos(ph));
        ry.push(radiusKm * Math.sin(th) * Math.sin(ph));
        rz.push(radiusKm * Math.cos(th));
      }
      x.push(rx); y.push(ry); z.push(rz);
    }
    return {
      type: "surface", x, y, z, name, opacity, showscale: false, showlegend: false, // labelled in the scene instead
      colorscale: [[0, color], [1, color]], hoverinfo: "name", contours: { x: { highlight: false }, y: { highlight: false }, z: { highlight: false } },
    };
  }

  function render3d(el, event) {
    const L = event.latest;
    const [r, t, n] = L.relative_position_rtn_m.map(km);
    const sc = L.sigma_r_m.chaser, st = L.sigma_r_m.target;
    const capped = Math.max(sc, st) > SIGMA_SENTINEL_M;
    const sigmaKm = km(Math.hypot(sc, st));
    const tier = TIER[event.tier];
    // Zoom to the event, but always far enough out to show the 1 km critical shell; the 5 km shell only if it fits.
    const span = Math.max(Math.max(Math.abs(r), Math.abs(t), Math.abs(n)) * 1.5, CRITICAL_KM * 1.15);
    const traces = [
      ...(span >= CRITICAL_KM ? [sphere(CRITICAL_KM, C.critical, 0.18, "1 km (critical)")] : []),
      ...(span >= ELEVATED_KM ? [sphere(ELEVATED_KM, C.warning, 0.06, "5 km (elevated)")] : []),
      {
        type: "scatter3d", mode: "lines", name: "miss vector", x: [0, r], y: [0, t], z: [0, n],
        line: { color: C.muted, width: 2 }, hoverinfo: "skip", showlegend: false,
      },
    ];
    if (!capped) {
      // Only radial sigma is in the data, so uncertainty is drawn along R only (±1σ solid, ±3σ faint).
      const clip = (v) => Math.max(-span, Math.min(span, v));
      for (const [k, w, o] of [[3, 2, 0.45], [1, 5, 0.9]]) {
        traces.push({
          type: "scatter3d", mode: "lines", name: `±${k}σ radial`, x: [clip(r - k * sigmaKm), clip(r + k * sigmaKm)],
          y: [t, t], z: [n, n], line: { color: C.text, width: w }, opacity: o,
          hovertemplate: `±${k}σ radial: ${fmtDist(k * Math.hypot(sc, st))}<extra></extra>`,
        });
      }
    }
    traces.push(
      {
        type: "scatter3d", mode: "markers+text", name: "target", x: [0], y: [0], z: [0], text: ["target"],
        textposition: "bottom center", textfont: { color: C.muted }, showlegend: false,
        marker: { size: 6, color: C.text, symbol: "diamond", line: { color: C.surface, width: 2 } },
        hovertemplate: "target (our satellite)<extra></extra>",
      },
      {
        type: "scatter3d", mode: "markers+text", name: L.object_type.toLowerCase(), x: [r], y: [t], z: [n],
        text: [L.object_type.toLowerCase()], textposition: "top center", textfont: { color: C.text }, showlegend: false,
        marker: { size: 8, color: tier.color, line: { color: C.surface, width: 2 } }, // becomes a tier ring once icons load
        hovertemplate:
          `${esc(L.object_type.toLowerCase())}<br>miss ${fmtDist(L.miss_distance_m)}<br>` +
          `R ${fmtKm(r)} · T ${fmtKm(t)} · N ${fmtKm(n)} km<extra></extra>`,
      },
    );

    const axis = (title) => ({
      title: { text: title, font: { color: C.muted } }, range: [-span, span], color: C.muted,
      gridcolor: C.grid, zerolinecolor: C.grid, showbackground: false, ticksuffix: "",
    });
    const obj = esc(L.object_type.toLowerCase());
    const article = /^[aeiou]/.test(obj) ? "An" : "A";
    el.innerHTML = `
      <div class="ca-head">${tierBadge(event.tier)} <strong>Event ${esc(event.event_id)}</strong> ${cautionBadges(event)}</div>
      <p class="ca-sentence">${article} ${obj === "unknown" ? "unidentified object" : obj} passes
        <b>${fmtDist(L.miss_distance_m)}</b> from our satellite in <b>${L.time_to_tca_days.toFixed(1)} days</b>,
        ${distanceLine(L.miss_distance_m)}.</p>
      <div class="ca-readings">
        ${reading("Miss distance", fmtDist(L.miss_distance_m))}
        ${reading("Time to closest approach", `${L.time_to_tca_days.toFixed(1)} d`)}
        ${reading("Closing speed", `${(L.relative_speed_ms / 1000).toFixed(1)} km/s`)}
        ${reading("Collision probability", `≤ ${fmtPc(L.max_risk_estimate_log10)}`, "upper bound")}
        ${reading("Radial uncertainty", capped ? UNKNOWN : fmtDist(Math.hypot(sc, st)), capped ? "not in the data" : "1σ, combined")}
      </div>
      <div class="ca-plot"></div>
      <div class="ca-note">Where the object is at closest approach, with our satellite at the centre. Distances are to scale
        (km); the object icons are enlarged so you can see them, and a faded icon means no usable uncertainty. The data only gives uncertainty in the radial (up/down) direction, so it is drawn along R.</div>`;
    const plotEl = el.querySelector(".ca-plot");
    const addIcons = () =>
      ICONS.then((ic) => {
        if (!ic || !plotEl.isConnected) return;
        const size = span * 0.24;
        const other = ic[ICON_FOR[L.object_type] || "unknown"];
        Plotly.restyle(plotEl, { "marker.symbol": "circle-open", "marker.size": 34, "marker.line.width": 3, "marker.color": tier.color, "marker.line.color": tier.color }, [traces.length - 1]);
        Plotly.restyle(plotEl, { "marker.opacity": 0 }, [traces.length - 2]);
        return Plotly.addTraces(plotEl, [
          iconMesh(ic.own_satellite, [0, 0, 0], size, OWN_COLOR, 1, "our satellite (icon enlarged)"),
          iconMesh(other, [r, t, n], size, OBJECT_COLOR, capped ? 0.35 : 1, `${L.object_type.toLowerCase()} (icon enlarged)`),
        ]);
      });
    return Plotly.newPlot(
      plotEl,
      traces,
      {
        paper_bgcolor: "rgba(0,0,0,0)", font, margin: { l: 0, r: 0, t: 0, b: 0 }, height: 420,
        legend: { orientation: "h", x: 0, y: 1, font: { color: C.muted } },
        scene: {
          annotations: [
            [CRITICAL_KM, "1 km critical", C.critical],
            [ELEVATED_KM, "5 km elevated", C.warning],
          ]
            .filter(([k]) => span >= k)
            .map(([k, text, color]) => ({
              x: 0, y: 0, z: k, text, showarrow: false, yshift: 10, font: { color, size: 11 },
            })),
          xaxis: axis("R radial (up)"), yaxis: axis("T along-track"), zaxis: axis("N normal"),
          aspectmode: "cube", camera: { eye: { x: 1.4, y: 1.4, z: 0.9 } },
        },
      },
      config,
    ).then((gd) => (addIcons(), gd));
  }

  function renderCompare(el, events) {
    const shown = events.slice(0, MAX_COMPARE);
    const lineTrace = (e, i, field, yaxis, toY, fmt) => {
      const h = e.history;
      return {
        type: "scatter", mode: "lines+markers", name: `Event ${e.event_id}`, legendgroup: String(e.event_id),
        showlegend: yaxis === "y", xaxis: "x", yaxis,
        x: h.map((p) => p.time_to_tca_days), y: h.map((p) => toY(p[field])),
        line: { color: C.series[i], width: 2 }, marker: { size: 8, color: C.series[i], line: { color: C.surface, width: 2 } },
        customdata: h.map((p) => [fmt(p[field]), TIER[p.pred_tier].name]),
        hovertemplate: `Event ${e.event_id}<br>%{x:.1f} d to TCA<br>%{customdata[0]} · %{customdata[1]}<extra></extra>`,
      };
    };
    const traces = shown.flatMap((e, i) => [
      lineTrace(e, i, "miss_distance_m", "y", km, fmtDist),
      lineTrace(e, i, "max_risk_estimate_log10", "y2", (v) => v, fmtPc),
    ]);
    // On a log axis Plotly wants shapes in data units but annotations in log10 units.
    const threshold = (y, yref, color, label, log = false) => ({
      shape: { type: "line", xref: "paper", x0: 0, x1: 1, yref, y0: y, y1: y, line: { color, width: 1, dash: "dash" } },
      ann: {
        xref: "paper", x: 1, xanchor: "right", yref, y: log ? Math.log10(y) : y, yanchor: "bottom",
        text: label, showarrow: false, font: { color: C.muted, size: 11 },
      },
    });
    const lines = [
      threshold(CRITICAL_KM, "y", C.critical, "1 km critical", true),
      threshold(ELEVATED_KM, "y", C.warning, "5 km elevated", true),
      threshold(-4, "y2", C.critical, "Pc 1e-4 critical"),
      threshold(-6, "y2", C.warning, "Pc 1e-6 elevated"),
    ];
    const yax = (title, domain, extra) => ({
      title: { text: title, font: { color: C.muted } }, domain, color: C.muted, gridcolor: C.grid, zeroline: false, ...extra,
    });

    const rows = shown
      .map(
        (e, i) => `<tr>
          <td><span class="ca-swatch" style="background:${C.series[i]}"></span>${esc(e.event_id)}</td>
          <td>${tierBadge(e.tier)}</td><td>${e.latest.time_to_tca_days.toFixed(1)} d</td>
          <td>${fmtDist(e.latest.miss_distance_m)}</td><td>${trend(e)}</td><td>${fmtPc(e.latest.max_risk_estimate_log10)}</td>
          <td>${e.history.length}</td><td>${cautionBadges(e) || '<span class="ca-muted">—</span>'}</td></tr>`,
      )
      .join("");
    el.innerHTML = `
      ${events.length > MAX_COMPARE ? `<div class="ca-note">Comparing the first ${MAX_COMPARE} of ${events.length} selected events.</div>` : ""}
      <p class="ca-sentence">Is it getting closer? Top: predicted miss distance at each update. Bottom: collision
        probability upper bound. Dashed lines are the tier thresholds; time runs left to right toward closest approach.</p>
      <div class="ca-plot"></div>
      <table class="ca-table"><thead><tr><th>Event</th><th>Tier</th><th>Closest in</th><th>Miss now</th><th>Trend</th><th>Pc ≤</th><th>Updates</th><th>Cautions</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    return Plotly.newPlot(
      el.querySelector(".ca-plot"),
      traces,
      {
        paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font, height: 460,
        margin: { l: 64, r: 16, t: 28, b: 44 }, hovermode: "closest",
        legend: { orientation: "h", x: 0, y: 1.08, font: { color: C.text } },
        xaxis: { title: { text: "days to closest approach", font: { color: C.muted } }, autorange: "reversed", color: C.muted, gridcolor: C.grid, zeroline: false },
        yaxis: yax("miss distance (km, log)", [0.56, 1], { type: "log", dtick: 1 }), // decades only: 0.1, 1, 10 km
        yaxis2: yax("Pc upper bound (log10)", [0, 0.44], { anchor: "x" }),
        shapes: lines.map((l) => l.shape),
        annotations: lines.map((l) => l.ann),
      },
      config,
    );
  }

  // Match a host page's palette, e.g. theme({ critical: "#ff4a3d", warning: "#e8a33c", below: "#8a9490" }).
  function theme(patch) {
    Object.assign(C, patch);
    [TIER[0].color, TIER[1].color, TIER[2].color] = [C.below, C.warning, C.critical];
  }

  window.CloseApproach = { render3d, renderCompare, theme, MAX_COMPARE };
})();
