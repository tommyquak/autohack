# What makes our collision risk evaluator different

**Challenge #1: AI-driven satellite collision avoidance**

> **One-line pitch:** We don't just tell operators which conjunctions are dangerous *now*. We tell them which ones **will become** dangerous, **how sure we are** (with a Critical miss rate that is set as a target and measured), and **why**, so analysts only spend time on the events that need a human.

`[X]` = fill in from `reports/metrics.json` at the 15:00 feature freeze (TEAM.md: no hand-typed numbers in the pitch).
Numbers that are not `[X]` are from the cross-validation in `algorithm.md` §2.4. They must also come from
`metrics.json` before the pitch.

---

## The problem, in the brief's words

Operators "receive thousands of data messages daily." Evaluating every one "necessitates too much manual labor and is vulnerable to human error." The brief asks for a system that classifies risk "backed by probability," "automatically flag[s] high-risk events that require maneuver planning," and "generate[s] insights."

## Where our team's system starts, and where this adds to it

Our team's **nowcast** (`docs/ALGO.md`) classifies every warning as it arrives: below threshold / Elevated / Critical. It uses only the allowed columns, catches every Critical warning in the test set, and halves false Elevated alerts. That answers "how dangerous is this warning *now*?"

It can't answer "where will this event *end up*?" The test data has no warning within 2 days of closest approach, which `docs/ALGO.md` lists as a known limit. A model that simply re-reads each warning's own `risk` value would just re-learn a fixed rule. Even a forecasting model built from each event's history only ties the simple "latest value" baseline (our cross-validation, `algorithm.md` §2.4). In ESA's own competition, **only 12 of 97 teams beat that baseline.**

We built for the gap the baseline can't cover.

---

## Feature 1: Early-warning escalation forecasting

### "Predict, don't just classify"

| | |
|---|---|
| **Brief requirement** | "Automatically flagging high-risk events that require maneuver planning" |
| **What it does** | Using only warnings received **2+ days before closest approach**, the system predicts which events will **escalate** to a higher tier by closest approach, before the official tier shows it. A Bayesian forecaster (stretch goal) also draws the expected risk and miss-distance curve with uncertainty bands up to closest approach. |
| **Why it matters** | NASA's maneuver decision happens 0.5–1 day before closest approach. Flagging escalations 2+ days out gives an extra 1–1.5 days for tracking requests and maneuver planning. It also fills the brief's **24-hour view** on the test data. The team's current 24-hour count is empty there, because no test warning is within 2 days of closest approach. Ours shows the events *forecast* to come within 1 km. |
| **Proof** | The "latest value" baseline catches **0 of 244** escalating events (it can't, by definition). Ours catches **[X] / 244**, with **[X] false escalations**, and Critical recall held at **≥ 0.82**. |
| **What's different** | Other teams classify the *current* risk. We forecast the *change*, anchored on the baseline, which is the only pattern that has reliably beaten it in published work (ESA competition winner; Neuraspace benchmark). |

---

## Feature 2: Coverage-controlled triage

### "Every flag says how sure we are, and the Critical miss rate is a measured target"

| | |
|---|---|
| **Brief requirement** | "Risk classification… backed by probability" and "too much manual labor… vulnerable to human error" |
| **What it does** | Each event gets calibrated probabilities for below threshold / Elevated / Critical. Conformal prediction then turns them into a **prediction set** with a **coverage target**: across events that end up Critical, at least 95% should be flagged. Events go to one of three queues: **AUTO-CLEAR** (only "below threshold" is plausible), **ANALYST REVIEW** (uncertain), **MANEUVER PLANNING** (Critical is plausible). |
| **Why it matters** | Analysts stop reading every warning. They read only the uncertain ones, and the miss rate on dangerous events is set in advance and checked, rather than hoped for. |
| **Proof** | **[X]% of events auto-cleared**, with measured Critical coverage of **[X]%** (target ≥ 95%) in cross-validation. The target holds on average for events like the training events. It is not a per-event promise. |
| **What's different** | Our team's nowcast already uses the same split-conformal idea for one decision per warning: when it is safe to drop a false Elevated. We apply it **per event and per class**, so the Critical target holds for Critical specifically, on the forecast of the *final* tier. That matches NASA CARA's recommendation that ML be used to *prioritise analyst attention* with uncertainty quantification. |

---

## Feature 3: Explainable, benchmarked, policy-aware decisions

### "Trustworthy enough for operators, and it tells them something new"

| | |
|---|---|
| **Brief requirement** | "In accordance with NASA… and ESA… standards" and "generate insights" |
| **What it does** | **(a) Explains every flag** in plain English, e.g. "miss distance shrinking over last 3 updates · debris object · high tracking uncertainty". **(b) Benchmarks everything** against the industry-standard "latest value" baseline on identical, leak-free splits. **(c) Audits the thresholds themselves:** the dashboard shows whether each Critical flag comes from Pc or from miss distance alone. The per-warning version of (c) is already in `events.json` (`reasons`). We add the event-level breakdown. |
| **Why it matters** | NASA CARA states that fully automated ML decisions are "not currently viable" and calls for explainability and baseline validation. We meet that standard rather than working around it. |
| **Proof / insight** | Of the 908 training events whose last warning is Critical, **895 (98.6%) are Critical only because of the < 1 km miss-distance rule**. Just 13 have Pc ≥ 10⁻⁴, and only 3 of those would be Critical on Pc alone. The NASA handbook itself warns that Pc and miss distance are poorly correlated and that a miss-distance cutoff "would result in a huge number of unnecessary mitigations." Our system makes this visible, so operators can tell which maneuvers are backed by Pc and which come only from the miss-distance rule. |
| **What's different** | Others report a bare accuracy figure. We show **what we beat, by how much, why each decision was made**, and an issue in the rulebook itself. |

---

## Side-by-side

| | Typical solution | Ours (nowcast + forecast) |
|---|---|---|
| What the model predicts | Current tier, often from a row that already contains the answer | Current tier from allowed columns (nowcast) **and change in tier** by closest approach (forecast) |
| Lead time | None | **2+ days before closest approach** |
| Probability | Raw score or none | Calibrated, with a **Critical coverage target measured in cross-validation** |
| Workload | Every warning shown | **Auto-clear / review / maneuver** queues |
| Explanation | Feature importance chart | **Per-event reasons in plain English** |
| Validation | Accuracy, random row split | **Vs industry baseline, event-grouped splits, false escalations reported** |
| Insight | Counts of Critical events | **Pc vs miss-distance audit of the rulebook** |

---

## Anticipated judge questions

**"Why not a deep learning model?"**
We scoped one: a Bayesian recurrent network that forecasts risk and miss distance with uncertainty. The published Bayesian network that predicted absolute risk directly scored slightly worse than the simple baseline (Abay et al., 2021), so ours forecasts the *change* instead and feeds the official rule engine. It is a stretch goal. Whether or not it ships, we show its numbers against the same baseline, including if it doesn't beat it.

**"How do you know it's better?"**
Same leak-free 5-fold split for every model, scored against "latest value": the baseline that only 12 of 97 teams beat in ESA's competition. We report escalations caught **and** false escalations, because a model that over-warns can "catch" escalations for free. Results table: [X].

**"Do you use the collision probability column as an input?"**
No. `risk` (log₁₀ Pc) defines the true tier, so it is only ever the label. It isn't needed either: the baseline built from miss distance alone is as good as the one built from `risk` (`algorithm.md` §2.4).

**"Would you trust it to maneuver automatically?"**
No, and neither does NASA. The system decides what an analyst **doesn't** need to look at, with a Critical miss rate that is targeted and measured. Humans make the maneuver call on the events that matter.

**"Why does the miss-distance finding matter?"**
If operators used Pc alone, most of these Critical flags would drop out of the maneuver queue. That's fuel, satellite downtime and analyst hours, and it's what the NASA handbook warns about.

---

## Sources

- [ESA Kelvins competition results, Uriot et al. 2021](https://arxiv.org/html/2008.03069v2)
- [Neuraspace ML benchmark, Abay et al. 2021](https://conference.sdo.esoc.esa.int/proceedings/sdc8/paper/123/SDC8-paper123.pdf)
- [Bayesian deep learning for CDMs, Acciarini et al. 2020](https://arxiv.org/pdf/2012.12450)
- [NASA CA Best Practices Handbook Rev 2](https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf)
- [NASA CARA AI/ML Compendium, AMOS 2025](https://amostech.com/TechnicalPapers/2025/ConjunctionRPO/Mashiku.pdf)
- [Forecast–Pareto–Conformal framework, UTEP 2026](https://scholarworks.utep.edu/open_etd/4770/)
