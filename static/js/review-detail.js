// The selected event, in reading order: the decision and its queue, three figures, why the tier holds (decision record),
// how it approached, and the wording folded away (it repeats the figures).
// Every value comes from /api/events/{id} and /api/explain/{id}?llm=false; nothing here recomputes a tier.
import { TIERS, CAUTIONS, esc, fmtDist, fmtDays, fmtPc } from "./fmt.js";
import { approachChart, pcStrip, rtnChart } from "./review-chart.js";

const PC_MIN = -8, PC_MAX = -2; // log10 span of the Pc scale; values outside are pinned to its ends

const tierName = (t) => (TIERS[t] || TIERS[0]).name;
const fmtScore = (v) => (v >= 0.001 ? v.toFixed(4) : v.toExponential(1));
const prettyRule = (r) => r.replace(/pc_bound/g, "Pc upper bound").replace(/\[1e-6, 1e-4\)/, "1e-6 to 1e-4");

const CAUTION_LABEL = { ...CAUTIONS, needs_review: "Low confidence" }; // "Needs review" would repeat the queue name

// One short reason per event, from its action queue, escalation flag and cautions (all from /api). The list shows
// `short`; the detail headline shows `long` after the queue. Wording never says "safe" and never advises acting.
export function reasonOf(ev) {
  const a = ev.action || {}, cz = ev.cautions || [];
  if (a.queue === "MANEUVER PLANNING") {
    const pc = (a.reasons || []).some((r) => /^Critical: Pc/.test(r));
    return pc ? { short: "Pc-backed", long: "Pc-backed", cls: "c2" } : { short: "distance only", long: "distance only", cls: "c2" };
  }
  if (a.queue === "MONITOR") {
    return ev.tier < ev.baseline_tier
      ? { short: "demoted", long: `demoted from ${tierName(ev.baseline_tier)}`, cls: "c0" }
      : { short: "below", long: "below threshold", cls: "c0" };
  }
  if (a.escalation_watch) return { short: "watch", long: "escalation watch", cls: "c1" };
  if (cz.includes("no_covariance")) return { short: "check input", long: "check input", cls: "cx" };
  if (cz.includes("pc_diluted")) return { short: "Pc diluted", long: "Pc may be diluted", cls: "cx" };
  if (ev.tier === 1) return { short: "Elevated", long: "Elevated", cls: "c1" };
  if (cz.includes("needs_review")) return { short: "low confidence", long: "low confidence", cls: "cx" };
  return { short: tierName(ev.tier), long: tierName(ev.tier), cls: "c0" };
}

function headline(ev) {
  const why = esc(reasonOf(ev).long);
  const q = ev.action?.queue;
  let h;
  if (q === "MANEUVER PLANNING") {
    h = `<p class="verdict q2">${esc(ev.tier_name || tierName(ev.tier))} <span class="tn">(Maneuver Required)</span> <span class="decides">Analyst decides</span><span class="why"> · ${why}</span></p>`;
  } else if (q === "MONITOR") h = `<p class="verdict q0">Monitor<span class="why"> · ${why}</span></p>`;
  else h = `<p class="verdict q1">Analyst review<span class="why"> · ${why}</span></p>`;
  // The queue it sits in and the first reason the action layer gives (both from /api), under the headline.
  const first = (ev.action?.reasons || [])[0];
  const label = q ? q.charAt(0) + q.slice(1).toLowerCase() : "No queue";
  return `${h}<p class="queue-why">Queue: <b>${esc(label)}</b>${first ? ` · ${esc(first)}` : ""}</p>`;
}

// why_not_candidate and input_flags from the certificate, in plain words: "rule tier is Critical (cannot be demoted); ..."
const WHY_NOT = [
  [/^Critical$/, "rule tier is Critical (cannot be demoted)"],
  [/^Elevated by miss distance$/, "Elevated by miss distance (only a Pc-only Elevated can be demoted)"],
  [/^below threshold by rule/, "already below threshold by rule (nothing to demote)"],
  [/^sigma placeholder/, "sigma is a placeholder (no usable covariance)"],
  [/^missing input \((.*)\)$/, "input missing ($1)"],
  [/^unknown object type$/, "object type is unknown"],
];
const FLAG = [
  [/^sigma placeholder$/, "sigma is a placeholder"],
  [/^unknown object type$/, "object type is unknown"],
  [/^(.*) missing$/, "$1 missing"],
];
const human = (s, table) => {
  for (const [re, out] of table) if (re.test(s)) return s.replace(re, out);
  return s;
};
function whyNot(c) {
  const parts = [human(c.why_not_candidate || "not a candidate", WHY_NOT)];
  for (const f of c.input_flags || []) {
    const h = human(f, FLAG);
    if (!parts.some((p) => p.includes(h) || p.includes(f.replace(/ missing$/, "")))) parts.push(h); // said already
  }
  return `No: ${parts.join("; ")}`;
}

function pcScale(log10, grey = false) {
  const W = 240, H = 30, pad = 6;
  const x = (v) => pad + ((Math.min(PC_MAX, Math.max(PC_MIN, v)) - PC_MIN) / (PC_MAX - PC_MIN)) * (W - 2 * pad);
  const yb = 9;
  const mk = Number.isFinite(log10) ? `<line class="mk${grey ? " grey" : ""}" x1="${x(log10)}" x2="${x(log10)}" y1="2" y2="${yb + 9}"/>` : "";
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
  const noCov = (ev.cautions || []).includes("no_covariance");
  const cautions = (ev.cautions || []).map((c) => CAUTION_LABEL[c] || c);
  return `
    <p class="meta">Event <b class="num">${esc(ev.event_id)}</b> · ${esc(String(L.object_type || "unknown object").toLowerCase())} · <span class="num">${esc(ev.n_updates ?? (ev.history || []).length)}</span> updates${cautions.length ? `<span class="caution"> · ${cautions.map(esc).join(" · ")}</span>` : ""}</p>
    <h1 class="sr">Event ${esc(ev.event_id)}</h1>
    ${headline(ev)}
    <dl class="readings">
      <div><dt>Miss distance</dt><dd class="num">${L.miss_distance_m != null ? esc(fmtDist(L.miss_distance_m)) : "unknown"}</dd></div>
      <div class="pc"><dt>Pc upper bound</dt>
        <dd class="num${noCov ? " grey" : ""}">${pcKnown ? esc(fmtPc(pc)) : "unknown"}</dd>
        ${pcScale(pc, noCov)}
        ${pcKnown ? (noCov ? `<p class="sub">no usable covariance: do not rely on Pc alone</p>` : "") : `<p class="sub">missing: never demoted</p>`}</div>
      <div><dt>Time to TCA</dt><dd class="num">${L.time_to_tca_days != null ? esc(fmtDays(L.time_to_tca_days)) : "unknown"}</dd></div>
    </dl>`;
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
  const eligible = c.candidate ? "Yes: Elevated by the Pc upper bound alone, miss over 5 km, usable inputs" : esc(whyNot(c));
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
    <li><span class="k">Eligible</span><span class="v">${eligible}</span></li>
    <li><span class="k">Score</span><span class="v">${score}</span></li>
    <li class="end t${c.tier}"><span class="k">Decision</span><span class="v">${decision}${holds}</span></li></ol>`;
}

// Dot colours in the approach chart are the tier at each update; the legend names only the tiers that appear.
function legend(ev) {
  const seen = [...new Set((ev.history || []).map((h) => h.pred_tier).filter((t) => TIERS[t]))].sort((a, b) => b - a);
  if (!seen.length) return "";
  return `<span class="legend" title="Dot colour: tier at that update">${seen.map((t) => `<span><i style="background:${TIERS[t].color}"></i>${esc(TIERS[t].name)}</span>`).join("")}</span>`;
}

// The data has no orbits: relative position in R/T/N is the only geometry. Per update when history carries it,
// else the latest value only.
function rtn(ev) {
  const p = ev.latest?.relative_position_rtn_m;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return "";
  const f = (v) => `${v < 0 ? "\u2212" : ""}${esc(fmtDist(Math.abs(v)))}`;
  return `<p class="rtn">Latest relative position <span class="num">R ${f(p[0])} · T ${f(p[1])} · N ${f(p[2])}</span></p>`;
}

export function renderDetail(el, ev, explain) {
  const src = explain ? (explain.source && explain.source !== "template" ? esc(explain.source) : "template") : "";
  const expl = explain
    ? `<details class="expl-d"><summary>Explanation <span class="muted">(${src})</span></summary><p class="expl">${esc(explain.text)}</p></details>`
    : `<p class="muted small">Explanation unavailable.</p>`;
  el.innerHTML = `
    <section class="s-sum">${summary(ev)}</section>
    <section><h2>Decision record</h2>${record(ev)}</section>
    <section><h2>Approach <span class="muted">miss distance per update, by days to TCA</span>${legend(ev)}</h2><div class="chart-wrap" id="chart"></div>
      <p class="strip-h">Pc upper bound${(ev.cautions || []).includes("no_covariance") ? ` <span class="muted">(grey: no usable covariance)</span>` : ""}</p><div id="pcstrip"></div>
      <p class="strip-h">Relative position R / T / N</p><div id="rtnchart"></div>${rtn(ev)}</section>
    <section class="s-expl">${expl}</section>`;
  drawChart(el, ev);
}

export function drawChart(el, ev) {
  const wrap = el.querySelector("#chart");
  if (!wrap) return;
  const w = wrap.clientWidth || 560;
  wrap.innerHTML = approachChart(ev.history, w);
  el.querySelector("#pcstrip").innerHTML = pcStrip(ev.history, w, (ev.cautions || []).includes("no_covariance"));
  const r = rtnChart(ev.history, w);
  el.querySelector("#rtnchart").innerHTML = r;
  el.querySelector("#rtnchart").previousElementSibling.hidden = !r; // no per-update R/T/N: keep the latest line only
}
