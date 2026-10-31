# Conjunction triage: fewer false alarms, every Critical kept

**Autonomous SG 2026 · Airbus Challenge #1 (satellite collision avoidance).** Published rules put
every conjunction warning into a tier, and a model removes only the over-warnings.

**CDMs arrive → rules tier every message → model removes only the over-warnings → analyst reviews a ranked queue with reasons → analyst decides**

## The problem

**User:** a conjunction assessment analyst on a satellite operator's flight dynamics team.
**Status quo:** every CDM whose Pc upper bound (`max_risk_estimate`) or miss distance crosses a
threshold gets a human look. **Cost, measured on our test set (24,484 CDMs):** that rule flags
**54.2%** of CDMs, and 4,526 of those are truly below threshold.

## What it does

- **Tiers** each CDM with the challenge's NASA (NASA/SP-20205011318) and ESA thresholds: Critical if Pc ≥ 1e-4 or miss < 1 km; Elevated if Pc ≥ 1e-6 or miss 1-5 km.
- **Demotes** only CDMs that are Elevated *solely* because of a loose Pc bound (miss > 5 km), and only to below threshold. It never touches Critical.
- **Flags** needs review, placeholder covariance (`no_covariance`) and probability dilution (`pc_diluted`). Flags only escalate.
- **Explains** each event: Claude rewords structured facts, with a template fallback.
- **Serves** an API and dashboard views (`/api/*`, `static/`), plus one prediction per test CDM in `predictions/test_predictions.csv`.

## How it works

| Job | Done by | LLM? |
|---|---|---|
| Assign the tier | Rules (`triage/tiers.py`) | No |
| Remove over-warnings | Gradient-boosted classifier with monotonic constraints, event-grouped CV (`triage/model.py`) | No |
| Detect unreliable inputs | Physics checks: placeholder sigma, sigma > miss/√2 (`triage/explain.py`) | No |
| Explain the event | Claude rewords fixed facts; template if no key, an error, or the word "safe" (`triage/explain.py`) | Yes |
| Decide on a manoeuvre | The analyst | No |

The demotion threshold is the 1% quantile of out-of-fold scores on truly-Elevated candidates.
`risk` (true log10 Pc) is the label only, never an input. Details: [docs/ALGO.md](docs/ALGO.md).

## Results (held-out test set: 24,484 CDMs, 2,167 events)

From [`data/demo/metrics.json`](data/demo/metrics.json). True classes: 15,756 below threshold, 6,501 Elevated, 2,227 Critical.

| Method | Critical recall | False alarms (truly below threshold) | Flagged | Under-tiered CDMs | Macro F1 |
|---|---|---|---|---|---|
| Majority class | 0% | 0 | 0.0% | 8,728 | 0.261 |
| Miss-distance rule | 95.9% | 0 | 31.4% | 1,116 | **0.952** |
| `max_risk_estimate` rule (status quo) | 100% | 4,534 | 54.2% | 0 | 0.841 |
| **Ours** | **100%** | **2,214** | **44.7%** | **1** | 0.910 |

**Where we lose:** the miss-distance rule has the highest macro F1 (0.952) but misses 4.1% of
Critical CDMs (91 of 2,227), so we don't use it.

**Before → after (vs status quo):** false Elevated 4,526 → 2,206 (**-51%**, 2,320 fewer false
alarms); flagged 54.2% → 44.7%; events in the queue 1,090 → 802 (from `data/demo/events.json`);
Critical recall stays 100%. These are measured counts; analyst time saved is not measured.

## Where it fails (and how the analyst knows)

- **1 CDM tiered too low.** Event 1278 (test row 14473), 4.62 days to TCA, miss 23,375 m, Pc upper
  bound 10^-5.61; true Pc 10^-5.92 is just over 1e-6, so the truth is Elevated. We showed it as below
  threshold with confidence 0.99 and no flag. *Why:* it looks like its neighbours (6 of the event's
  10 bound-Elevated CDMs are truly below 1e-6). *How they'd know:* not from that CDM. The updates
  before (5.12 d) and after (4.39 d, needs review) stayed Elevated, and `baseline_tier` is kept next
  to `tier` on every update, so a demotion always shows as a demotion.
- **Over-tiered Criticals, by design.** 165 truly-Elevated CDMs (and 8 truly below threshold) are shown
  as Critical because their Pc bound is ≥ 1e-4. We never demote Critical.
- **63 events with placeholder sigma** (63,781,360 m). These are never demoted and always flagged `no_covariance` + needs review.
- **No test CDM within 2 days of TCA** (minimum 2.0002 d), so the 24 h panel is empty and the final window is untested.
- **The 99% target is not a per-event guarantee.** It holds only for events drawn like the training events.

## Our eval caught our bug

Our first model regressed log Pc and flagged 100% of CDMs. The independent evaluation caught this
before it shipped, so we redesigned it as targeted demotion.

## Trust and traceability

- Every tier lists the rules that fired (e.g. `Pc 10^-3.20 >= 1e-4 (critical threshold)`).
- Uncertainty only escalates: needs review and cautions never lower a tier.
- Claude only rewords structured facts and uses only their numbers. It never recommends a manoeuvre, and each response records `claude` or `template` as its source.
- Tier 0 is "below threshold", never "safe". The analyst decides the manoeuvre.

## What we don't solve yet

- A calibrated Pc estimate: we use the provided upper bound plus a classifier.
- Orbit propagation: the 3D view shows relative position at TCA, not to scale.
- A live CDM feed: `triage.predict --data any.csv` works on new files, but nothing streams.
- Configurable thresholds: they are fixed to the brief (`triage/tiers.py`).

## Run it

```bash
uv sync
uv run uvicorn server:app --reload    # http://127.0.0.1:8000, serves the frozen data/demo reports
```
Optional: put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`) for Claude explanations; without it the template is used.

Full pipeline (organisers' CSVs in `data/raw/`, see [data/README.md](data/README.md)):
```bash
uv run python -m triage.train          # -> reports/model.joblib
uv run python -m triage.evaluate       # -> reports/metrics.json
uv run python -m triage.build_events   # -> reports/events.json
uv run python -m triage.predict        # -> predictions/test_predictions.csv
uv run pytest -q                       # runs on data/sample, no key needed
```

Docs: [ALGO](docs/ALGO.md) (method) · [CONTRACT](docs/CONTRACT.md) (interfaces) · [TEAM](docs/TEAM.md) (roles, workflow).

## Team

Tommy: model, API, PM · Franky: explanation, cautions, 3D close-approach and compare views ·
Reagan: dashboard · Kalent: independent evaluation
