"""Web server: POST /chat streams agent events as newline-delimited JSON."""

import json
import uuid

from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from agent import MODEL, run_agent

app = FastAPI()
SESSIONS: dict[str, list] = {}  # in-memory conversation history per browser tab


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


@app.get("/")
def index():
    return FileResponse("static/index.html")


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
