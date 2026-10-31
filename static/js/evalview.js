// Evaluation tab: how well the model works, read straight from /api/metrics (docs/CONTRACT.md §3).
// Every figure is derived from that file; nothing is typed in. Tiers are "Below threshold", never "safe".
import { TIERS, esc, pct } from "./fmt.js";
import { state, subscribe } from "./state.js";

const LABEL = {
  majority_class: ["Majority class", "always below threshold"],
  miss_distance_rule: ["Miss-distance rule", "flags by distance only"],
  max_risk_estimate_rule: ["Pc upper-bound rule", "the baseline the model improves on"],
  model: ["Model", "rules plus a demotion classifier"],
};
const ORDER = ["majority_class", "miss_distance_rule", "max_risk_estimate_rule", "model"];

let el;

export function initEval() {
  const css = document.createElement("link");
  Object.assign(css, { rel: "stylesheet", href: "/static/eval.css" });
  document.head.append(css);

  const tabs = document.getElementById("tabs");
  tabs.insertAdjacentHTML("beforeend", `<button role="tab" aria-selected="false" data-tab="eval">Evaluation</button>`);
  tabs.parentElement.insertAdjacentHTML("beforeend", `<div class="panel" id="panel-eval" role="tabpanel" hidden><div class="ev" id="ev"></div></div>`);
  el = document.getElementById("ev");
  subscribe(["metrics"], render);
  render();
}

const n = (v) => Number(v).toLocaleString("en");
// Rows of a confusion matrix are the truth, columns the prediction (Below threshold, Elevated, Critical).
const underTiered = (c) => c.reduce((s, row, i) => s + row.slice(0, i).reduce((a, b) => a + b, 0), 0);
const criticalMissed = (c) => c[2][0] + c[2][1];
const falseElevated = (c) => c[0][1];

function render() {
  const m = state.metrics;
  if (!m?.results?.model) {
    el.innerHTML = `<p class="muted">Evaluation numbers are not built. Run <code>uv run python -m triage.evaluate</code>.</p>`;
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

  el.innerHTML = `
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
