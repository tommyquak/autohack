# Team roles (modelled on lvl 500, HackHarvard 2026 SpaceXAI winner)

lvl 500's split: one owner per **layer**, layers talk only through small contracts, and the
**evaluator is not the model builder** - their independent eval caught a wrong metric (0.53) the
builder couldn't see by eye. Same here. Contracts: `docs/CONTRACT.md`.

| lvl 500 | Our role | Owns (files) | Contract they publish / consume |
|---|---|---|---|
| Candy - globe + web app, data pipeline, QA, design | **1. Visualisation & UI** | `static/dashboard.*`, `triage/build_events.py`, demo script, Devpost write-up | consumes `events.json`, `metrics.json` |
| David - API + agent, scoring model (+ PM here) | **2. Model & API (logic) + PM** | `triage/features.py`, `triage/train.py`, `triage/model.py`, `server.py` `/api/*` | publishes `predict()` + `/api/*` |
| Sarah - Chalk service + Agent Evals | **3. Evaluation (independent)** | `triage/evaluate.py`, `tests/`, baselines, failure cases, "Honest evaluation" slide | publishes `metrics.json`; can veto a model change that lowers Critical recall |
| Evan - agent flow with local fallback, globe events, saved compare | **4. Integration & trust** | `/api/explain` (Claude + template fallback), dashboard interactions (select event → 3D view, compare), dilution/needs-review UX | consumes `predict()` + `/api/*` |
| - | **5. Algorithms forecast** | `docs/algorithm/`, `triage/forecast_*.py` (planned): per-event forecast of the tier at TCA, on top of the nowcast | consumes `triage/tiers.py`, `triage/features.py`; will publish a per-event `forecast` in `events.json` once the contract PR is agreed (proposal: `docs/algorithm/algorithm.md` §4.1) |

**Assignments:** 1 Visualisation & UI = **Reagan** · 2 Model & API (logic) + PM = **Tommy** · 3 Evaluation = **Kalent** · 4 Integration & trust = **Franky** · 5 Algorithms forecast = **Kalent**
(Swap freely by strengths - just keep the evaluator separate from the model owner.)
Kalent holds both 3 and 5, so on forecast PRs a teammate other than Kalent runs `python -m triage.evaluate` and posts the table.

## Rules (what made lvl 500 parallel)
- Work only in your files; change a contract only in a PR that updates all consumers + tests.
- Every number on screen comes from `metrics.json` / `events.json` - never typed into the UI or pitch by hand.
- Evaluator runs `python -m triage.evaluate` on every model PR and posts the table in the PR.
- Say "below threshold", never "safe". Label synthetic data. Show one failure.
- Branch -> PR -> green CI -> squash merge (auto-merge on). Pull `main` every ~30 min.

## Timeline (build ~10:30-16:30; confirm the official submission deadline and shift rows)
| By | Milestone | Owner |
|---|---|---|
| 11:15 | Scaffold + CI merged; everyone running on `data/sample` | 2 |
| 12:30 | Model v1 + eval table vs baseline; dashboard shell on stub `events.json` | 2, 3, 1 |
| 14:00 | 3D close-approach view + funnel; explain with fallback; failure case chosen | 1, 4, 3 |
| 15:00 | **Feature freeze.** Full test-set run; numbers locked into `metrics.json` | 2, 3 |
| 15:45 | 3-min pitch rehearsed twice; submission written (early = time points) | 2 + all |
| 16:00 | Submit | 2 |

## 3-minute pitch split
0:00-0:30 problem + user (2, PM) · 0:30-1:30 live dashboard: funnel → critical event → 3D view (1/4) ·
1:30-2:15 model + safety design: "can only remove false alarms" (2) · 2:15-2:50 honest eval: baseline, workload saved, a failure (3) · 2:50-3:00 close (2)

## Git workflow (4 people, 6 hours)
`main` is protected: every change goes through a pull request, and CI (lint + format + tests) must pass.
```
git switch -c feat/<thing>        # one branch per feature, keep them small
uv run ruff format . && uv run ruff check --fix . && uv run pytest -q   # same checks as CI
git push -u origin HEAD && gh pr create --fill
gh pr merge --squash --auto       # merges itself once CI is green
```
- Pull `main` often (`git pull --rebase origin main`) - small PRs merged every ~30 min beat one big merge at 5:30pm.
- Never commit `.env` (it's gitignored). Each teammate uses their own API key.
- CI never calls the Claude API, so it costs no credits.

## Starter agent (chat at `/chat`, from the hackathon template)
- `cp .env.example .env` and paste your API key; `uv run cli.py "your task"` runs it from the terminal.
- Add a tool in `tools.py` with `@tool`: type hints + docstring become the schema. Use `@tool(side_effect=True)`
  for anything that changes the outside world; it is blocked unless `AUTO_APPROVE=1`.
- Knobs (`.env`): `EFFORT` (low → max; `medium` is a good demo default), `MAX_TURNS` (cap on model calls per
  message), system prompt in `SYSTEM_PROMPT` in `agent.py`.
