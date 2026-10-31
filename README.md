# autohack

Autonomous SG 2026 starter: streaming Claude agent with tools, web search, and a web UI.

## Challenge track: Satellite collision avoidance (Challenge #1)
Low earth orbit is crowded with satellites and debris, and operators get thousands of close-approach
warnings a day. Checking each by hand is slow and error-prone. We are building a **collision-risk
evaluator** that reads orbital conjunction telemetry, calculates the collision probability (Pc) for
satellite-debris pairs, and flags events that need a maneuver.

Risk tiers follow the NASA Spacecraft Conjunction Assessment and Collision Avoidance Best Practices
Handbook (NASA/SP-20205011318) and ESA Space Debris Office standards:

| Tier | Condition |
|---|---|
| Safe | Pc < 1e-6 **and** miss distance > 5.0 km |
| Elevated | 1e-6 <= Pc < 1e-4, **or** miss distance 1.0-5.0 km |
| Critical (maneuver required) | Pc >= 1e-4 (`risk` >= -4.0 in the dataset) **or** miss distance < 1.0 km |

Deliverables:
- The evaluator: fit on `train_data`, evaluate on unseen `test_data`.
- A dashboard of trajectories, risk scores and miss distances.
- A 24-hour view of how many objects enter the dangerous distance.

Data: `Challenge #1/archive(1).zip`. The `risk` column is log10(Pc). For a simpler model, stick to:
`event_id`, `time_to_tca`, `miss_distance`, `relative_speed`, `relative_position_r`,
`relative_position_t`, `relative_position_n`, `c_object_type`, `c_sigma_r`, `t_sigma_r`,
`max_risk_estimate`, `F10`, `AP`.

## Run
1. `cp .env.example .env` and paste your API key from platform.claude.com
2. `uv run uvicorn server:app --reload` → open http://127.0.0.1:8000
   or from the terminal: `uv run cli.py "your task"`

## Add a tool (tools.py)
```python
@tool
def get_flight(callsign: str) -> str:
    """Look up a live flight by callsign, e.g. SIA322."""
    ...
```
Type hints + docstring become the tool schema. Use `@tool(side_effect=True)` for anything
that changes the outside world; it is blocked unless `AUTO_APPROVE=1`.

## Knobs (.env)
- `EFFORT`: low (fast/cheap) → max (slowest, smartest). `medium` is a good demo default.
- `MAX_TURNS`: cap on model calls per message, so a runaway loop can't burn credits.
- System prompt: `SYSTEM_PROMPT` in agent.py.

## Team workflow (4 people, 6 hours)
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
