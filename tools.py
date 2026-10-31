"""Tools the agent can call. Add one by writing a typed, documented function
and decorating it with @tool - the JSON schema is generated from the signature.

    @tool
    def get_flight(callsign: str) -> str:
        "Look up a live flight by callsign, e.g. SIA322."
        ...

Mark anything with real-world side effects as @tool(side_effect=True): it is
blocked unless AUTO_APPROVE=1, so a demo never fires something you didn't mean to.
"""

import asyncio
import inspect
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, get_type_hints
from zoneinfo import ZoneInfo

import httpx

AUTO_APPROVE = os.getenv("AUTO_APPROVE", "0") == "1"
_PY_TO_JSON = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}


@dataclass
class Tool:
    fn: Callable
    schema: dict
    side_effect: bool


TOOLS: dict[str, Tool] = {}


def tool(fn=None, *, side_effect: bool = False):
    def register(f):
        hints = get_type_hints(f)
        props, required = {}, []
        for name, param in inspect.signature(f).parameters.items():
            props[name] = {"type": _PY_TO_JSON.get(hints.get(name, str), "string")}
            if param.default is inspect.Parameter.empty:
                required.append(name)
        TOOLS[f.__name__] = Tool(
            fn=f,
            side_effect=side_effect,
            schema={
                "name": f.__name__,
                "description": inspect.getdoc(f) or f.__name__,
                "input_schema": {"type": "object", "properties": props, "required": required},
            },
        )
        return f
    return register(fn) if fn else register


def validate_input(name: str, args) -> str | None:
    """Return an error string if the (eagerly streamed) input doesn't match the schema."""
    t = TOOLS.get(name)
    if t is None:
        return f"Unknown tool: {name}"
    if not isinstance(args, dict):
        return "INVALID_JSON: tool input must be an object"
    schema = t.schema["input_schema"]
    missing = [k for k in schema["required"] if k not in args]
    if missing:
        return f"INVALID_JSON: missing required fields {missing}"
    types = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}
    for key, val in args.items():
        spec = schema["properties"].get(key)
        if spec is None:
            return f"INVALID_JSON: unexpected field {key!r}"
        if not isinstance(val, types[spec["type"]]):
            return f"INVALID_JSON: field {key!r} should be {spec['type']}"
    return None


async def run_tool(name: str, args: dict) -> tuple[bool, str]:
    t = TOOLS[name]
    if t.side_effect and not AUTO_APPROVE:
        return False, f"Blocked: {name} has side effects and AUTO_APPROVE is off. Describe what you would do instead."
    try:
        if inspect.iscoroutinefunction(t.fn):
            out = await t.fn(**args)
        else:
            out = await asyncio.to_thread(t.fn, **args)
        return True, out if isinstance(out, str) else json.dumps(out, default=str)
    except Exception as e:  # surface tool failures to the model instead of crashing the loop
        return False, f"{type(e).__name__}: {e}"


# --- Example tools -------------------------------------------------------------

@tool
def get_current_time() -> str:
    """Get the current date and time in UTC and Singapore time."""
    now = datetime.now(timezone.utc)
    sgt = now.astimezone(ZoneInfo("Asia/Singapore"))
    return f"UTC {now:%Y-%m-%d %H:%M}; Singapore {sgt:%Y-%m-%d %H:%M}"


@tool
async def http_get(url: str) -> str:
    """HTTP GET a public URL (JSON API or web page) and return the first 8000 characters of the body."""
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        r = await c.get(url, headers={"User-Agent": "autonomous-sg-hackathon"})
        return f"HTTP {r.status_code}\n{r.text[:8000]}"


@tool(side_effect=True)
def send_notification(message: str) -> str:
    """Send a notification to the operator. Example of a side-effecting tool gated by AUTO_APPROVE."""
    print(f"[NOTIFY] {message}")
    return "sent"
