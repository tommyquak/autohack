// Evaluation tab: the triage funnel (see funnel.js) above how well the model works, read straight from /api/metrics (docs/CONTRACT.md §3).
// Every figure is derived from that file; nothing is typed in. Tiers are "Below threshold", never "safe".
// The organisers' task (final tier from CDMs >= 2 days out, metrics.forecast) leads the tab; the per-message
// nowcast (funnel + the figures below it) follows as supporting evidence.
import { TIERS, esc, pct } from "./fmt.js";
import { state, subscribe } from "./state.js";

const LABEL = {
  majority_class: ["Majority class", "always below threshold"],
  miss_distance_rule: ["Miss-distance rule", "flags by distance only"],
  max_risk_estimate_rule: ["Pc upper-bound rule", "the baseline the model improves on"],
  model: ["Model", "rules plus a demotion classifier"],
};
const ORDER = ["majority_class", "miss_distance_rule", "max_risk_estimate_rule", "model"];

let el, top;
let split = "cv"; // "cv" = 5-fold CV mean ± sd, "holdout" = the 80/20 split by event

export function initEval() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/eval.css" });
  document.head.append(css);

  el = document.getElementById("ev");
  // The official panel goes above the funnel, at the very top of the tab.
  top = document.createElement("div");
  top.className = "evo-top";
  el.closest(".panel").prepend(top);
  top.addEventListener("click", (e) => {
    const b = e.target.closest("[data-split]");
    if (b && b.dataset.split !== split) ((split = b.dataset.split), renderOfficial());
  });
  subscribe(["metrics"], () => (renderOfficial(), render()));
  renderOfficial();
  render();
}

// ---- Official task: final tier from CDMs >= 2 days out (metrics.forecast) ----
const OFFICIAL = [
  ["second_look_forecast", "Second Look forecast", "rule floor + model escalation"],
  ["persistence_miss", "Keep today's tier", "miss-distance tier now · strongest baseline"],
  ["persistence_rule", "Pc-bound persistence", "Pc bound + miss rule tier now"],
];
const NOWCAST_H = `<h2 class="evo-part">Per-message nowcast (supporting)</h2>`;
const f3 = (v) => v.toFixed(3);
const pc1 = (v) => (v * 100).toFixed(1);

function renderOfficial() {
  const f = state.metrics?.forecast;
  const cv = f?.cv_5fold?.summary, ho = f?.protocol_80_20?.results;
  if (!cv?.second_look_forecast || !ho?.second_look_forecast) {
    top.innerHTML = "";
    return;
  }
  const isCV = split === "cv";
  const R = isCV ? cv : ho;
  const nEvents = f.cohort.n_events;
  const critShare = f.cohort.final_tier_counts.Critical / nEvents;
  const nFolds = f.cv_5fold.folds?.length ?? 5;
  const val = (r, k) => (isCV ? r[k].mean : r[k]);
  const tot = (r, k) => (isCV ? r[k].sum : r[k]);

  const rows = OFFICIAL.filter(([k]) => R[k]).map(([k, name, sub]) => {
    const r = R[k];
    const cell = (key, fmt, unit = "") => (isCV ? `${fmt(r[key].mean)}${unit}<small>± ${fmt(r[key].sd)}</small>` : `${fmt(r[key])}${unit}`);
    return `<tr${k === "second_look_forecast" ? ' class="is-model"' : ""}>
      <th scope="row">${esc(name)}<span>${esc(sub)}</span></th>
      <td class="num">${cell("critical_recall", pc1, "%")}</td><td class="num">${cell("critical_precision", pc1, "%")}</td>
      <td class="num">${cell("critical_f2", f3)}</td>
      <td class="num">${n(tot(r, "escalations_caught"))} / ${n(tot(r, "false_escalations"))}<small>caught of ${n(tot(r, "escalations"))}</small></td>
      <td class="num">${cell("accuracy", pc1, "%")}</td><td class="num">${cell("macro_f1", f3)}</td></tr>`;
  }).join("");

  // Confusion: the 80/20 held-out events, or summed over the CV folds' out-of-fold predictions.
  const cm = R.second_look_forecast.confusion;
  const max = Math.max(...cm.flat());
  const heads = TIERS.map((t) => `<th scope="col" style="color:${t.color}">${t.icon} ${esc(t.name)}</th>`).join("");
  const body = cm.map((row, i) => {
    const rowSum = row.reduce((a, b) => a + b, 0);
    return `<tr><th scope="row" style="color:${TIERS[i].color}">${TIERS[i].icon} ${esc(TIERS[i].name)}</th>${row.map((c, j) =>
      `<td class="num${i === j ? " diag" : ""}" style="--a:${(Math.sqrt(c / max) * 32).toFixed(1)}%"><b>${n(c)}</b><small>${rowSum ? pct(c / rowSum) : ""}</small></td>`).join("")}</tr>`;
  }).join("");

  // The honest comparison, worded from the numbers rather than assumed.
  const sl = R.second_look_forecast, keep = R.persistence_miss;
  const cmp = (key, get) => (get(sl, key) > get(keep, key) ? "higher" : get(sl, key) < get(keep, key) ? "lower" : "the same");
  const rec = cmp("critical_recall", val), caught = cmp("escalations_caught", tot);
  const prec = cmp("critical_precision", val), acc = cmp("accuracy", val);
  const honest = rec === "higher" && caught === "higher" && prec === "lower" && acc === "lower"
    ? "Higher Critical recall and escalation catch than keeping today's tier, at lower precision and accuracy; the recall target is a target, not a guarantee."
    : `Against keeping today's tier: ${rec} Critical recall, ${caught} escalation catch, ${prec} precision and ${acc} accuracy. The recall target is a target, not a guarantee.`;
  const op = f.decision_layer?.shipped_thresholds;
  const opLine = op
    ? `Operating point: Critical recall target ${pct(op.critical_recall_target)} on out-of-fold training scores, giving t<sub>crit</sub> ${op.t_crit.toFixed(3)} and t<sub>elev</sub> ${op.t_elev.toFixed(3)}. Scores rank events; they are not calibrated probabilities.`
    : "";
  const splitNote = isCV
    ? `Mean ± sd over ${nFolds} folds of ${n(nEvents)} events; escalation counts summed over folds.`
    : `One held-out 20% of events (${n(f.protocol_80_20.n_val)}), trained on the other ${n(f.protocol_80_20.n_train)}.`;

  top.innerHTML = `
    <section class="evo" aria-labelledby="evo-h">
      <h2 class="evo-part" id="evo-h">Official task: final tier from CDMs ≥ 2 days out</h2>
      <p class="evo-sub">80/20 split by event + ${nFolds}-fold CV over ${n(nEvents)} usable train events; Critical ≈ ${Math.round(critShare * 100)}% of events</p>
      <div class="evo-bar">
        <div class="evo-seg" role="group" aria-label="Evaluation split">
          <button type="button" data-split="cv" aria-pressed="${isCV}">${nFolds}-fold CV</button>
          <button type="button" data-split="holdout" aria-pressed="${!isCV}">80/20 held out</button>
        </div>
        <span class="evo-note">${splitNote}</span>
      </div>
      <table class="ev-table evo-table"><thead><tr><th scope="col">Method</th><th scope="col">Critical recall</th><th scope="col">Critical precision</th>
        <th scope="col" title="F-beta with beta = 2: recall weighted above precision">Critical F2</th>
        <th scope="col" title="Events whose final tier is higher than at the latest ≥ 2 d CDM: how many were caught, and how many escalations were raised that did not happen">Escalations caught / false</th>
        <th scope="col">Accuracy</th><th scope="col">Macro F1</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="evo-split">
        <figure class="evo-cm">
          <figcaption>Second Look forecast, ${isCV ? `out-of-fold events summed over the ${nFolds} folds` : "80/20 held-out events"}</figcaption>
          <div class="evo-grid">
            <span class="evo-ax-y">True final tier</span>
            <div><span class="evo-ax-x">Predicted final tier</span>
              <table class="evo-matrix"><thead><tr><td></td>${heads}</tr></thead><tbody>${body}</tbody></table></div>
          </div>
          <p class="ev-foot">Counts of events; the small figure is the share of that true tier. Shading follows the count.</p>
        </figure>
        <div class="evo-read">
          <p class="evo-honest">${honest}</p>
          ${opLine ? `<p class="ev-foot">${opLine}</p>` : ""}
        </div>
      </div>
    </section>`;
}

const n = (v) => Number(v).toLocaleString("en");
// Rows of a confusion matrix are the truth, columns the prediction (Below threshold, Elevated, Critical).
const underTiered = (c) => c.reduce((s, row, i) => s + row.slice(0, i).reduce((a, b) => a + b, 0), 0);
const criticalMissed = (c) => c[2][0] + c[2][1];
const falseElevated = (c) => c[0][1];

function render() {
  const m = state.metrics;
  if (!m?.results?.model) {
    el.innerHTML = `${NOWCAST_H}<p class="muted">Evaluation numbers are not built. Run <code>uv run python -m triage.evaluate</code>.</p>`;
    return;
  }
  const R = m.results, model = R.model, base = R.max_risk_estimate_rule;
  const cm = model.confusion, crit = m.class_counts.CRITICAL;
  const missedM = criticalMissed(cm), missedB = base ? criticalMissed(base.confusion) : null;
  const events = state.summary?.n_events;

  const lead = base
    ? `The model misses ${n(missedM)} of ${n(crit)} Critical CDMs and flags ${pct(model.flagged_rate)} of them for review, against ${pct(base.flagged_rate)} for the Pc upper-bound rule, which misses ${n(missedB)}.`
    : `The model misses ${n(missedM)} of ${n(crit)} Critical CDMs and flags ${pct(model.flagged_rate)} of them for review.`;

  const best = ORDER.filter((k) => R[k]).reduce((a, b) => (R[b].macro_f1 > R[a].macro_f1 ? b : a));
  const loses = best !== "model"
    ? `Where it loses: the ${LABEL[best][0].toLowerCase()} has the higher macro F1 (${R[best].macro_f1.toFixed(3)} against ${model.macro_f1.toFixed(3)}), but it misses ${n(criticalMissed(R[best].confusion))} Critical CDMs. Missing a Critical is the costly error, so recall comes first.`
    : "";

  const rows = ORDER.filter((k) => R[k]).map((k) => {
    const r = R[k], c = r.confusion, isModel = k === "model";
    return `<tr${isModel ? ' class="is-model"' : ""}>
      <th scope="row">${esc(LABEL[k][0])}<span>${esc(LABEL[k][1])}</span></th>
      <td class="num">${n(criticalMissed(c))}</td><td class="num">${pct(r.critical_recall)}</td>
      <td class="num">${pct(r.flagged_rate)}</td><td class="num">${n(falseElevated(c))}</td>
      <td class="num">${n(underTiered(c))}</td><td class="num">${r.macro_f1.toFixed(3)}</td></tr>`;
  }).join("");

  const buckets = (m.by_lead_time?.model || []).map((row, i) => {
    const bar = (key, cls) => {
      const r = m.by_lead_time[key]?.[i];
      return r ? `<div class="lt-row"><span class="lt-name">${esc(LABEL[key][0])}</span>
        <span class="lt-bar"><i class="${cls}" style="width:${(r.flagged_rate * 100).toFixed(1)}%"></i></span>
        <span class="num lt-val">${pct(r.flagged_rate)}</span><span class="num lt-rec">recall ${pct(r.critical_recall)}</span></div>` : "";
    };
    return `<div class="lt"><div class="lt-head"><b class="num">${row.days_to_tca[0]}–${row.days_to_tca[1]} days</b> to closest approach <span class="muted num">${n(row.n)} CDMs</span></div>
      ${bar("max_risk_estimate_rule", "base")}${bar("model", "mdl")}</div>`;
  }).join("");

  const heads = TIERS.map((t) => `<th scope="col" style="color:${t.color}">${t.icon} ${esc(t.name)}</th>`).join("");
  const matrix = cm.map((row, i) => `<tr><th scope="row" style="color:${TIERS[i].color}">${TIERS[i].icon} ${esc(TIERS[i].name)}</th>${row.map((v, j) =>
    `<td class="num${i === j ? " diag" : ""}${j < i && v ? " under" : ""}${j > i && v ? " over" : ""}" title="${v ? n(v) : "none"}">${n(v)}</td>`).join("")}</tr>`).join("");

  const under = underTiered(cm);
  const listed = m.under_tiered || m.missed_criticals || [];
  const failure = listed.length
    ? `<ul class="ev-fail">${listed.slice(0, 5).map((f) => `<li>Event ${esc(f.event_id)}${f.time_to_tca != null ? ` at ${Number(f.time_to_tca).toFixed(1)} d` : ""} <a href="/#compare=${encodeURIComponent(f.event_id)}">open in Compare</a></li>`).join("")}</ul>`
    : under
      ? `<p>${n(under)} CDM${under === 1 ? " was" : "s were"} rated lower than the truth (amber cell). The metrics file does not name the event, so there is nothing to link to yet.</p>`
      : `<p>No CDM was rated lower than the truth.</p>`;

  el.innerHTML = `${NOWCAST_H}
    <p class="ev-lead">${lead}</p>
    ${loses ? `<p class="ev-note">${esc(loses)}</p>` : ""}
    <section aria-labelledby="ev-h1"><h3 id="ev-h1">Model against three baselines</h3>
      <table class="ev-table"><thead><tr><th scope="col">Method</th><th scope="col" title="Truly Critical CDMs rated lower">Critical missed</th><th scope="col">Critical recall</th>
        <th scope="col">Flagged</th><th scope="col" title="CDMs truly below threshold that were raised to Elevated">False Elevated</th>
        <th scope="col" title="CDMs rated lower than their true tier">Under-tiered</th><th scope="col">Macro F1</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="ev-foot">Counted per CDM on the ${esc(m.split)} set: ${n(model.n)} CDMs${events ? ` from ${n(events)} events` : ""}.</p></section>
    ${buckets ? `<section aria-labelledby="ev-h2"><h3 id="ev-h2">Share of CDMs flagged, by time to closest approach</h3>${buckets}</section>` : ""}
    <section aria-labelledby="ev-h3"><h3 id="ev-h3">What the model said, against the truth</h3>
      <table class="ev-matrix"><thead><tr><td></td>${heads}</tr></thead><tbody>${matrix}</tbody></table>
      <p class="ev-foot">Rows are the true tier, columns what the model said. The diagonal is correct.</p>
      <div class="ev-failure"><h4>Where it is wrong</h4>${failure}</div></section>`;
}
