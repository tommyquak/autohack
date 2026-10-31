"""Web server.

Dashboard API (reads the files written by `triage.build_events` and `triage.evaluate`; shapes in docs/CONTRACT.md):
    GET /api/summary            events.json "summary"
    GET /api/events             every event without its CDM history (?tier=0|1|2, ?needs_review=true)
    GET /api/events/{event_id}  one event with full history
    GET /api/metrics            metrics.json
    GET /api/explain/{event_id} plain-English summary (Claude, template fallback; triage/explain.py)
    GET /health                 {"llm": "claude"|"fallback", "reports": "reports"|"demo"|"missing",
                                 "model", "last_answer": who answered the last chat message}

Pages: GET / (dashboard, static/dashboard.html) · GET /chat (copilot chat). POST /chat streams copilot events as NDJSON:
{"type": "session"}, then {"type": "source", "source": "claude"|"fallback"}, then text / thinking / tool_call /
tool_result / error events and {"type": "done"}. A focus_event tool_call names the event the dashboard should select.
Fallback (fallback.py, deterministic) answers when there are no usable credentials, or when the Claude call fails
before any text has streamed; in that case a second "source" event switches to "fallback".
"""

import json
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import fallback
from agent import MODEL, run_agent
from triage import explain, reports
from triage.reports import BUILD_HINT, ReportMissing, events_by_id, load_report  # noqa: F401  (re-exported)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")
SESSIONS: dict[str, list] = {}  # in-memory conversation history per browser tab
LAST_SOURCE: str | None = None  # who answered the most recent chat message: "claude" | "fallback"


# ---------- reports (loading lives in triage/reports.py so tools.py can share it) ----------


@app.exception_handler(ReportMissing)
async def _report_missing(_: Request, exc: ReportMissing):
    return JSONResponse({"detail": str(exc)}, status_code=503)


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
    event = events_by_id().get(event_id)
    if event is None:
        raise HTTPException(404, f"event {event_id} not in reports/events.json")
    return event


@app.get("/api/metrics")
def api_metrics():
    """metrics.json, plus a "forecast" block (final tier from >= 2-day messages) when forecast_metrics.json exists."""
    out = load_report("metrics.json")
    try:
        return {**out, "forecast": load_report("forecast_metrics.json")}
    except ReportMissing:
        return out


@app.get("/api/explain/{event_id}")
async def api_explain(event_id: int, llm: bool = True):
    """Plain-English summary of one event: Claude when available, deterministic template otherwise."""
    event = events_by_id().get(event_id)
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
    """The team dashboard once it exists; until then the working prototype; the API list as a last resort."""
    for page in ("dashboard.html", "prototype.html"):
        if (STATIC / page).exists():
            return FileResponse(STATIC / page)
    return HTMLResponse(PLACEHOLDER)


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


@app.get("/health")
def health():
    """Which engine will answer chat, which copy of the reports is served, and who answered last."""
    return {
        "llm": "claude" if explain._has_credentials() else "fallback",
        "reports": reports.source(),
        "model": MODEL,
        "last_answer": LAST_SOURCE,
    }


def _source(name: str, reason: str | None = None) -> dict:
    global LAST_SOURCE
    LAST_SOURCE = name
    return {"type": "source", "source": name} | ({"reason": reason} if reason else {})


async def _fallback(message: str, messages: list):
    text = []
    for event in fallback.events(message):
        if event["type"] == "text":
            text.append(event["text"])
        yield event
    messages.append({"role": "assistant", "content": "".join(text)})  # keep the history alternating


async def _copilot(message: str, messages: list):
    """Claude when available; the deterministic fallback when it isn't or fails before any text."""
    if not explain._has_credentials():
        yield _source("fallback", "no API credentials configured")
        async for event in _fallback(message, messages):
            yield event
        return

    started = saw_text = False
    reason = "Claude call failed"
    agent = run_agent(messages)
    try:
        async for event in agent:
            if event["type"] == "error" and not saw_text:
                reason = event.get("text") or reason
                break
            if not started:
                started = True
                yield _source("claude")
            saw_text = saw_text or event["type"] == "text"
            yield event
        else:
            return
    except Exception as e:  # e.g. the SDK finds no credentials at all
        reason = f"{type(e).__name__}: {e}"[:200]
        if saw_text:
            yield {"type": "error", "text": "The Claude call failed mid-answer."}
            yield {"type": "done"}
            return
    finally:
        await agent.aclose()
    yield _source("fallback", reason)
    async for event in _fallback(message, messages):
        yield event


@app.post("/chat")
async def chat(req: ChatRequest):
    sid = req.session_id or str(uuid.uuid4())
    messages = SESSIONS.setdefault(sid, [])
    messages.append({"role": "user", "content": req.message})

    async def stream():
        yield json.dumps({"type": "session", "session_id": sid}) + "\n"
        async for event in _copilot(req.message, messages):
            yield json.dumps(event, default=str) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/reset")
def reset(req: ChatRequest):
    SESSIONS.pop(req.session_id or "", None)
    return {"ok": True}
