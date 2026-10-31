# autohack

Autonomous SG 2026 starter: streaming Claude agent with tools, web search, and a web UI.

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
