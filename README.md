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
