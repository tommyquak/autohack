"""Web server.

Dashboard API (reads the files written by `triage.build_events` and `triage.evaluate`; shapes in docs/CONTRACT.md):
    GET /api/summary            events.json "summary"
    GET /api/events             every event without its CDM history (?tier=0|1|2, ?needs_review=true)
    GET /api/events/{event_id}  one event with full history
    GET /api/metrics            metrics.json
    GET /api/explain/{event_id} plain-English summary (Claude, template fallback; triage/explain.py)

Pages: GET / (dashboard, static/dashboard.html) · GET /chat (agent chat). POST /chat streams agent events as NDJSON.
"""

import json
import uuid
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agent import MODEL, run_agent
from triage import explain

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
REPORTS = ROOT / "reports"
DEMO = ROOT / "data" / "demo"  # frozen copy of the full-test-set reports, used when reports/ has none
BUILD_HINT = {
    "events.json": "uv run python -m triage.build_events",
    "metrics.json": "uv run python -m triage.evaluate",
}

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")
SESSIONS: dict[str, list] = {}  # in-memory conversation history per browser tab


# ---------- reports ----------


def _stamp(name: str) -> tuple[Path, float]:
    for path in (REPORTS / name, DEMO / name):
        if path.exists():
            return path, path.stat().st_mtime
    raise HTTPException(503, f"reports/{name} not found - run `{BUILD_HINT[name]}`")


# Keyed on (path, mtime): re-read only when the file changes, so a rebuild shows up without a restart.
@lru_cache(maxsize=4)
def _parse(path: Path, mtime: float) -> dict:
    return json.loads(path.read_text())


@lru_cache(maxsize=2)
def _index(path: Path, mtime: float) -> dict[int, dict]:
    return {e["event_id"]: e for e in _parse(path, mtime)["events"]}


def load_report(name: str) -> dict:
    return _parse(*_stamp(name))


def _events_by_id() -> dict[int, dict]:
    return _index(*_stamp("events.json"))


def _without_history(event: dict) -> dict:
    out = {k: v for k, v in event.items() if k != "history"}
    out["n_updates"] = len(event.get("history") or [])
    return out


@app.get("/api/summary")
def api_summary():
    return load_report("events.json")["summary"]


@app.get("/api/events")
def api_events(tier: int | None = None, needs_review: bool | None = None):
    """Events in urgency order (tier desc, then soonest TCA), without `history`; adds `n_updates`."""
    events = load_report("events.json")["events"]
    if tier is not None:
        events = [e for e in events if e["tier"] == tier]
    if needs_review is not None:
        events = [e for e in events if e["needs_review"] == needs_review]
    return {"total": len(events), "events": [_without_history(e) for e in events]}


@app.get("/api/events/{event_id}")
def api_event(event_id: int):
    event = _events_by_id().get(event_id)
    if event is None:
        raise HTTPException(404, f"event {event_id} not in reports/events.json")
    return event


@app.get("/api/metrics")
def api_metrics():
    return load_report("metrics.json")


@app.get("/api/explain/{event_id}")
async def api_explain(event_id: int, llm: bool = True):
    """Plain-English summary of one event: Claude when available, deterministic template otherwise."""
    event = _events_by_id().get(event_id)
    if event is None:
        raise HTTPException(404, f"event {event_id} not in reports/events.json")
    return await explain.explain(event, use_llm=llm)


# ---------- pages ----------

PLACEHOLDER = """<!doctype html><meta charset="utf-8"><title>Conjunction Triage</title>
<body style="font:14px ui-monospace,monospace;background:#080a0b;color:#cfd8d4;padding:24px">
<p>Dashboard not built yet (static/dashboard.html). API:</p>
<ul>
<li><a href="/api/summary">/api/summary</a></li><li><a href="/api/events">/api/events</a></li>
<li><a href="/api/metrics">/api/metrics</a></li><li><a href="/chat">/chat</a></li>
</ul></body>"""


@app.get("/")
def index():
    dashboard = STATIC / "dashboard.html"
    return FileResponse(dashboard) if dashboard.exists() else HTMLResponse(PLACEHOLDER)


@app.get("/chat")
def chat_page():
    return FileResponse(STATIC / "chat.html")


# ---------- agent chat ----------


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


@app.get("/config")
def config():
    return {"model": MODEL}


@app.post("/chat")
async def chat(req: ChatRequest):
    sid = req.session_id or str(uuid.uuid4())
    messages = SESSIONS.setdefault(sid, [])
    messages.append({"role": "user", "content": req.message})

    async def stream():
        yield json.dumps({"type": "session", "session_id": sid}) + "\n"
        async for event in run_agent(messages):
            yield json.dumps(event, default=str) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/reset")
def reset(req: ChatRequest):
    SESSIONS.pop(req.session_id or "", None)
    return {"ok": True}
