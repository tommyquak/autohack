// The selected event, in reading order: what it is, why the tier holds (decision record), how it approached, the wording.
// Every value comes from /api/events/{id} and /api/explain/{id}?llm=false; nothing here recomputes a tier.
import { TIERS, CAUTIONS, esc, fmtDist, fmtDays } from "./fmt.js";
import { approachChart } from "./review-chart.js";

const PC_MIN = -8, PC_MAX = -2; // log10 span of the Pc scale; values outside are pinned to its ends

const tierName = (t) => (TIERS[t] || TIERS[0]).name;
const fmtScore = (v) => (v >= 0.001 ? v.toFixed(4) : v.toExponential(1));
const prettyRule = (r) => r.replace(/pc_bound/g, "Pc upper bound").replace(/\[1e-6, 1e-4\)/, "1e-6 to 1e-4");

function pcBand(log10) {
  if (log10 >= -4) return "at or above 1e-4 (Critical line)";
  if (log10 >= -6) return "between 1e-6 and 1e-4 (Elevated band)";
  return "under 1e-6";
}

function pcScale(log10) {
  const W = 240, H = 30, pad = 6;
  const x = (v) => pad + ((Math.min(PC_MAX, Math.max(PC_MIN, v)) - PC_MIN) / (PC_MAX - PC_MIN)) * (W - 2 * pad);
  const yb = 9;
  const mk = Number.isFinite(log10) ? `<line class="mk" x1="${x(log10)}" x2="${x(log10)}" y1="2" y2="${yb + 9}"/>` : "";
  return `<svg class="pcscale" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <rect class="z0" x="${x(PC_MIN)}" y="${yb}" width="${x(-6) - x(PC_MIN)}" height="4"/>
    <rect class="z1" x="${x(-6) + 1}" y="${yb}" width="${x(-4) - x(-6) - 2}" height="4"/>
    <rect class="z2" x="${x(-4)}" y="${yb}" width="${x(PC_MAX) - x(-4)}" height="4"/>
    <text x="${x(-6)}" y="${H - 1}" text-anchor="middle">1e-6</text>
    <text x="${x(-4)}" y="${H - 1}" text-anchor="middle">1e-4</text>${mk}</svg>`;
}

function summary(ev) {
  const L = ev.latest || {};
  const pc = L.max_risk_estimate_log10;
  const pcKnown = Number.isFinite(pc);
  const cautions = (ev.cautions || []).map((c) => CAUTIONS[c] || c);
  return `
    <header class="ev-head">
      <h1>Event <span class="num">${esc(ev.event_id)}</span></h1>
      <p class="muted">${esc(String(L.object_type || "unknown object").toLowerCase())} · ${esc(ev.n_updates ?? (ev.history || []).length)} CDM updates</p>
    </header>
    <p class="tier t${ev.tier}">${esc(ev.tier_name || tierName(ev.tier))}${ev.tier === 2 ? ` <span>(Maneuver Required)</span>` : ""}</p>
    <dl class="readings">
      <div><dt>Miss distance</dt><dd class="num">${L.miss_distance_m != null ? esc(fmtDist(L.miss_distance_m)) : "unknown"}</dd></div>
      <div class="pc"><dt>Pc upper bound</dt>
        <dd class="num">${pcKnown ? `1e${pc.toFixed(1)}` : "unknown"}</dd>
        ${pcScale(pc)}
        <p class="sub">${pcKnown ? pcBand(pc) : "missing: never demoted"}</p></div>
      <div><dt>Time to TCA</dt><dd class="num">${L.time_to_tca_days != null ? esc(fmtDays(L.time_to_tca_days)) : "unknown"}</dd></div>
    </dl>
    ${cautions.length ? `<p class="caution">${cautions.map(esc).join(" · ")}</p>` : ""}`;
}

function record(ev) {
  const c = ev.certificate;
  if (!c) {
    const demoted = ev.tier < ev.baseline_tier;
    return `<ol class="record">
      <li><span class="k">Rule</span><span class="v">${esc(tierName(ev.baseline_tier))}</span></li>
      <li><span class="k">Eligible</span><span class="v muted">No decision record for this event</span></li>
      <li><span class="k">Score</span><span class="v muted">Not available</span></li>
      <li class="end t${ev.tier}"><span class="k">Decision</span><span class="v">${demoted ? `Demoted ${esc(tierName(ev.baseline_tier))} → ${esc(tierName(ev.tier))}` : `Stays ${esc(tierName(ev.tier))}`}</span></li></ol>`;
  }
  const rules = (c.rules_fired || []).map(prettyRule);
  const flags = (c.input_flags || []).length ? ` <span class="muted">(${c.input_flags.map(esc).join(", ")})</span>` : "";
  const eligible = c.candidate
    ? "Yes: Elevated by the Pc upper bound alone, miss over 5 km, usable inputs"
    : `No: ${esc(c.why_not_candidate || "not a candidate")}`;
  let score;
  if (c.model_score != null && c.threshold != null) {
    const under = c.model_score < c.threshold;
    const target = c.recall_target != null ? `, set for a ${Math.round(c.recall_target * 100)}% recall target` : "";
    score = `<span class="num">${fmtScore(c.model_score)}</span> ${under ? "under" : "not under"} threshold <span class="num">${fmtScore(c.threshold)}</span><span class="muted">${target}</span>`;
  } else {
    score = `<span class="muted">Not scored${c.candidate ? "" : ": only eligible events reach the model"}${c.model && c.model !== "trained" ? ` (${esc(c.model)})` : ""}</span>`;
  }
  let decision;
  if (c.decision === "demoted") decision = `Demoted ${esc(c.rule_tier_name)} → ${esc(c.tier_name)}`;
  else if (c.decision === "kept") decision = `Kept at ${esc(c.tier_name)}`;
  else decision = `Stays ${esc(c.tier_name)} (rule tier)`;
  const holds = c.holds
    ? `<span class="muted"> · invariants hold</span>`
    : `<span class="fail"> · invariant failed</span>`;
  return `<ol class="record">
    <li><span class="k">Rule</span><span class="v">${esc(c.rule_tier_name)}<span class="muted"> · ${rules.length ? rules.map(esc).join(" + ") : "no rule fired"}</span></span></li>
    <li><span class="k">Eligible</span><span class="v">${eligible}${flags}</span></li>
    <li><span class="k">Score</span><span class="v">${score}</span></li>
    <li class="end t${c.tier}"><span class="k">Decision</span><span class="v">${decision}${holds}</span></li></ol>`;
}

export function renderDetail(el, ev, explain) {
  const expl = explain
    ? `<p class="expl">${esc(explain.text)}</p>`
    : `<p class="muted">Explanation unavailable.</p>`;
  const src = explain && explain.source !== "template" ? esc(explain.source) : "template, no LLM";
  el.innerHTML = `
    <section class="s-sum">${summary(ev)}</section>
    <section><h2>Decision record</h2>${record(ev)}</section>
    <section><h2>Approach history <span class="muted">miss distance at each CDM update, by days to TCA</span></h2><div class="chart-wrap" id="chart"></div></section>
    <section><h2>Explanation <span class="muted">${src}</span></h2>${expl}</section>`;
  drawChart(el, ev);
}

export function drawChart(el, ev) {
  const wrap = el.querySelector("#chart");
  if (wrap) wrap.innerHTML = approachChart(ev.history, wrap.clientWidth || 560);
}
