# Build plan (team copy)

## Context
Team of 4 is doing Airbus Challenge #1 (satellite collision avoidance), inspired by HackHarvard winner lvl 500. Goal: a **collision risk evaluator** that classifies each conjunction message (CDM) as Safe / Elevated / Critical, flags manoeuvre-worthy events, and shows them on an operator dashboard — built to score on the rubric: technical soundness 25 (stats/rules for detection, LLM only for explanation), honest evaluation 20 (baseline, metrics, a visible failure), trust & traceability 20, problem realism 20, impact 10, time 5.

Repo: `tommyquak/autohack` (local `~/Desktop/autonomous-sg`). Existing starter: `agent.py` (Claude loop), `tools.py`, `server.py` (FastAPI), `static/index.html`, CI on PR #1 (ruff + pytest, branch `ci/setup`, **still open — user must merge first**).

### Key facts from the PDF that shape the design
- **Allowed features:** event_id, time_to_tca, miss_distance, relative_speed, relative_position_r/t/n, c_object_type, c_sigma_r, t_sigma_r, max_risk_estimate, F10, AP.
- **`risk` (= log10 Pc) is the label, not a feature.** Tiers (official thresholds):
  - Safe: Pc < 1e-6 **and** miss > 5 km
  - Elevated: 1e-6 ≤ Pc < 1e-4 **or** 1 km ≤ miss ≤ 5 km
  - Critical: Pc ≥ 1e-4 (risk ≥ −4) **or** miss < 1 km
  - Precedence Critical > Elevated > Safe. `miss_distance` is an allowed feature, so the miss-distance half of the rule is **deterministic**; only the Pc half needs a model.
- train_data → fit; test_data → predictions get scored. Dashboard: trajectories, risk scores, miss distances; 24-hour warnings.
- Dataset is very likely ESA Kelvins CAC (units: miss_distance in metres; many CDMs per event; risk floor −30). **Verify on arrival.**

## Approach (deterministic core, LLM at the edge)
1. **Rule layer** (`triage/tiers.py`): thresholds as named constants citing NASA/ESA; `true_tier(risk, miss)` for labels; `miss_rule_tier(miss)` used at inference.
2. **Pc-band model** (`triage/model.py`): sklearn `HistGradientBoostingClassifier` predicting Pc band (<1e-6 / 1e-6–1e-4 / ≥1e-4) from allowed features; class weights for the rare Critical class. Final tier = max(model band, miss rule).
3. **Uncertainty → escalate, never down-grade:** if top-class probability < threshold or the event's CDM history is unstable, output **"Elevated — needs review"**. Never print "safe"; use "below threshold".
4. **Baselines** (for honest eval): (a) threshold `max_risk_estimate` alone (conservative upper bound), (b) miss-distance rule alone, (c) majority class.
5. **Split by event_id** (GroupKFold) — CDMs of one event must not straddle train/val, otherwise scores are leaked. This is an explicit talking point.
6. **Metrics:** Critical recall (primary — a miss is the costly error), false-alarm rate, macro-F1, confusion matrix, and **performance by lead time** (time_to_tca buckets: how far ahead can we trust it). Report on group-CV and on test_data. Pick one **missed Critical** and explain it on the dashboard.
7. **Explanation (optional LLM):** `/api/explain/{id}` builds a plain-English summary from structured fields only via Claude (`claude-opus-5-5`, reuse `agent.py` client); **template fallback** when no key, so the demo never depends on it.

## Repo structure (new/changed)
```
data/
  README.md            # where the data comes from, access note, how to place it, column glossary
  sample/cdm_sample.csv  # ~200 events subsampled (incl. Critical ones), committed — used by tests, CI, dashboard dev
  raw/                 # gitignored: full train_data.csv / test_data.csv from the organisers' Drive
docs/
  PLAN.md              # this plan + 4-person split + timeline (committed for teammates)
  CONTRACT.md          # events.json + metrics.json schemas (the interfaces between people)
triage/
  __init__.py
  tiers.py             # thresholds + rule functions
  data.py              # load CSV, keep allowed columns, units, group split
  model.py             # train/predict Pc band, combine with rules, uncertainty flag
  evaluate.py          # CLI: baselines vs model → reports/metrics.json, confusion, failures
  build_events.py      # CLI: writes reports/events.json for the dashboard
reports/               # gitignored outputs (metrics.json, events.json, model.joblib)
static/dashboard.html  # operator UI (Plotly from cdnjs): event queue, 24h warnings, RTN geometry, risk-over-time, metrics tab
server.py              # + /api/events, /api/events/{id}, /api/summary, /api/metrics, /api/explain/{id}; "/" → dashboard, chat moves to /chat
tests/test_tiers.py    # exact boundaries (1e-6, 1e-4, 1 km, 5 km), precedence
tests/test_data.py     # group split has no event overlap; allowed-column filter; sample loads
tests/test_contract.py # events.json built from sample matches CONTRACT schema
.gitignore             # + data/raw/, reports/
pyproject.toml         # + pandas, scikit-learn, joblib
```
**Why not commit the full dataset:** ~100+ MB CSVs exceed GitHub's 100 MB file limit, and the organisers restricted Drive access. Teammates download it once into `data/raw/` (instructions in `data/README.md`); the committed sample keeps tests/CI/dashboard working for everyone.

Reuse: `server.py` app + `SESSIONS` pattern, `static/index.html` styling tokens, `agent.py` `client`/`MODEL`, CI workflow as-is.

## Delivery (branch → PR → green CI → user merges)
- **PR 2 `feat/ps1-scaffold` (me, first ~30 min after data lands):** data README + sample, docs/PLAN.md + CONTRACT.md, `tiers.py`, `data.py`, baseline-only `evaluate.py`, a stub `events.json` from the sample, tests. Unblocks everyone.
- Then parallel PRs per person:
  - **A — data & eval:** evaluate.py full metrics, lead-time breakdown, failure case selection.
  - **B — model:** model.py, class weights, uncertainty threshold tuned on CV (optimise Critical recall at bounded false alarms).
  - **C — API & explain:** server endpoints, explain with template fallback, build_events.py.
  - **D — dashboard:** dashboard.html against the stub events.json (no waiting on the model).
- **Timeline:** scaffold merged → model v1 + dashboard on stub (~T+2h) → integrate + metrics (~T+3.5h) → freeze, record numbers, 3-min pitch, **submit early** (~T+4.5h).

## Verification
- `uv run pytest -q` + ruff in CI on every PR (tests run on the committed sample, no API key).
- `uv run python -m triage.evaluate --data data/raw` prints baselines vs model; spot-check that `true_tier` distribution matches the PDF thresholds (count of risk ≥ −4 rows == Critical-by-Pc count).
- `uv run uvicorn server:app` → dashboard loads, 24h warning count matches a pandas one-liner, explain works with and without `ANTHROPIC_API_KEY`.
- First thing when data lands: confirm columns/units (miss_distance metres vs km), whether test_data contains `risk`, Critical prevalence — adjust plan if any differ.

## Open items for the user
- Merge PR #1 (`gh pr merge 1 --squash`) before PR 2 so CI is on main.
- Download Challenge #1 zip with your NUS account → `~/Desktop/autonomous-sg/data/raw/` (Drive blocks the Gmail account).
