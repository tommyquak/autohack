"""Web server.

Dashboard API (reads the files written by `triage.build_events` and `triage.evaluate`; shapes in docs/CONTRACT.md):
    GET /api/summary            events.json "summary"
    GET /api/events             every event without its CDM history (?tier=0|1|2, ?needs_review=true)
    GET /api/events/{event_id}  one event with full history
    GET /api/metrics            metrics.json
    GET /api/explain/{event_id} plain-English summary (Claude, template fallback; triage/explain.py)
    GET /api/audit              re-verifies the safety invariants over every served event (triage/certify.py)
    POST /api/triage            tiers CDM rows sent as JSON, each with its certificate and margin to the next tier
    GET /health                 {"llm": "claude"|"fallback", "reports": "reports"|"demo"|"missing",
                                 "model", "last_answer": who answered the last chat message}

Pages: GET / (dashboard, static/dashboard.html) · GET /chat (copilot chat). POST /chat streams copilot events as NDJSON:
{"type": "session"}, then {"type": "source", "source": "claude"|"fallback"}, then text / thinking / tool_call /
tool_result / error events and {"type": "done"}. A focus_event tool_call names the event the dashboard should select.
Fallback (fallback.py, deterministic) answers when there are no usable credentials, or when the Claude call fails
before any text has streamed; in that case a second "source" event switches to "fallback".
"""

import json
import math
import uuid
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import fallback
from agent import MODEL, run_agent
from triage import certify, explain, model, reports
from triage.data import CATEGORICAL, EVENT, FEATURES, validate_cdms
from triage.predict import predict_frame
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


# ---------- assured triage: live proof of the safety invariants ----------


@lru_cache(maxsize=2)
def _audit(path: Path, mtime: float) -> dict:
    # Keyed like the report cache: recomputed on rebuild only. The loaded model (reports/model.joblib, cached for the
    # process) must carry the same threshold as the served events.json.
    return certify.audit(reports._parse(path, mtime), model.load_artifact())


@app.get("/api/audit")
def api_audit():
    """Re-check the safety invariants over every event in the served events.json (rules recomputed from inputs)."""
    path, mtime = reports._stamp("events.json")
    return _audit(path, mtime) | {"generated_at_source": reports.source()}


MAX_TRIAGE_ROWS = 500
MAX_TRIAGE_BYTES = 1_000_000  # about 2 KB per row at the row cap; a 500-row body of the allowed columns is ~170 KB
MAX_EVENT_ID = 2**63 - 1


def _bad(msg: str):
    raise HTTPException(422, msg)


async def _read_body(request: Request) -> bytes:
    """The request body, refused with 413 once it passes MAX_TRIAGE_BYTES (checked while streaming, not after)."""
    too_big = f"request body over {MAX_TRIAGE_BYTES:,} bytes; send at most {MAX_TRIAGE_ROWS} CDM rows per request"
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_TRIAGE_BYTES:
        raise HTTPException(413, too_big)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_TRIAGE_BYTES:
            raise HTTPException(413, too_big)
    return bytes(body)


def _parse_cdms(body: bytes) -> list[dict]:
    """{"cdms": [...]} -> the row list, with the 1-500 row cap checked before any row is validated or framed."""
    try:
        data = json.loads(body)
    except ValueError:
        _bad('body must be JSON: {"cdms": [<CDM row>, ...]}')
    if not isinstance(data, dict) or "cdms" not in data:
        _bad('body must be a JSON object {"cdms": [<CDM row>, ...]}; field cdms is required')
    cdms = data["cdms"]
    if not isinstance(cdms, list):
        _bad(f"cdms must be a list of CDM rows, got {type(cdms).__name__}")
    if not 1 <= len(cdms) <= MAX_TRIAGE_ROWS:
        _bad(f"cdms must hold 1-{MAX_TRIAGE_ROWS} CDM rows, got {len(cdms)}")
    for i, r in enumerate(cdms):
        if not isinstance(r, dict):
            _bad(f"cdms[{i}] must be an object of column: value")
    return cdms


def _rows_frame(cdms: list[dict]) -> tuple[pd.DataFrame, list, list[str], list[str]]:
    """Validate JSON CDM rows into a frame like read_cdm_csv's. Keys absent -> 422; null -> missing value (escalated,
    never demoted). A non-finite number (Infinity, -Infinity, NaN) is not a measurement: it is treated exactly like
    null and listed in the returned `non_finite`. Columns other than event_id and the allowed inputs (including
    `risk`) are dropped unread."""
    ignored = sorted({k for r in cdms for k in r} - {EVENT, *FEATURES})
    given_ids, non_finite = [], []
    for i, r in enumerate(cdms):
        absent = [c for c in FEATURES if c not in r]
        if absent:
            _bad(f"cdms[{i}] is missing {absent}; send null for an unknown value")
        for c in FEATURES:
            v = r[c]
            if c in CATEGORICAL:
                if v is not None and not isinstance(v, str):
                    _bad(f"cdms[{i}].{c} must be a string or null, got {v!r}")
            elif v is not None and (isinstance(v, bool) or not isinstance(v, int | float)):
                _bad(f"cdms[{i}].{c} must be a number or null, got {v!r}")
            elif isinstance(v, float) and not math.isfinite(v):
                non_finite.append(f"cdms[{i}].{c}")  # validate_cdms turns it into NaN: missing, escalated, flagged
        eid = r.get(EVENT)
        if eid is not None and (isinstance(eid, bool) or not isinstance(eid, int) or not 0 <= eid <= MAX_EVENT_ID):
            _bad(f"cdms[{i}].event_id must be an integer from 0 to 2^63-1, or absent; got {eid!r}")
        given_ids.append(eid)
    # A row without event_id is its own one-CDM event: the synthetic ids are negative, and a sent id may not be.
    ids = [eid if eid is not None else -(i + 1) for i, eid in enumerate(given_ids)]
    frame = pd.DataFrame([{c: r[c] for c in FEATURES} for r in cdms]).assign(**{EVENT: ids})
    for c in FEATURES:
        if c not in CATEGORICAL:
            frame[c] = pd.to_numeric(frame[c], errors="coerce").astype(float)  # None -> NaN
    try:
        frame = validate_cdms(frame, "cdms")
    except ValueError as e:
        _bad(str(e))
    return frame, given_ids, ignored, non_finite


def _json_safe(x):
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, dict):
        return {k: _json_safe(v) for k, v in x.items()}
    if isinstance(x, list | tuple):
        return [_json_safe(v) for v in x]
    return x


@app.post("/api/triage")
async def api_triage(request: Request):
    """Tier CDM rows sent as JSON ({"cdms": [...]}, 1-500 rows, at most MAX_TRIAGE_BYTES) with the same pipeline as
    `python -m triage.predict`; works without labels. The body is read by hand so the size and row caps apply
    before any row is validated, and a too-long body is never echoed back in the 422."""
    cdms = _parse_cdms(await _read_body(request))
    return await run_in_threadpool(_triage, cdms)


def _triage(cdms: list[dict]) -> dict:
    frame, given_ids, ignored, non_finite = _rows_frame(cdms)
    out = predict_frame(frame, with_certificates=True)
    rows = frame.to_dict("records")
    results = []
    for i, (row, pred) in enumerate(zip(rows, out.to_dict("records"), strict=True)):
        cert = pred["certificate"]
        results.append(
            {
                "row": i,
                "event_id": given_ids[i],
                "tier": int(pred["pred_tier"]),
                "tier_name": pred["pred_tier_name"],
                "baseline_tier": int(pred["baseline_tier"]),
                "confidence": float(pred["confidence"]),
                "needs_review": bool(pred["needs_review"]),
                "reasons": certify.reasons(row, cert),
                "certificate": cert,
                "to_escalate": certify.to_escalate(row, cert),
            }
        )
    artifact = model.load_artifact()
    return _json_safe(
        {
            "n": len(results),
            "model": "trained" if artifact else "rules only",
            "all_invariants_hold": all(r["certificate"]["holds"] for r in results),
            "ignored_columns": ignored,
            "non_finite_as_missing": non_finite,
            "results": results,
        }
    )


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
