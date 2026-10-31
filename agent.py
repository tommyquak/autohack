"""Agent core: a streaming tool-use loop that yields UI-friendly events.

Add tools in tools.py; this file shouldn't need changes during the hackathon
except for SYSTEM_PROMPT and the knobs below.
"""

import asyncio
import json
import os
from collections.abc import AsyncIterator

import anthropic
from dotenv import load_dotenv

from tools import TOOLS, run_tool, validate_input

load_dotenv()

MODEL = os.getenv("MODEL", "claude-opus-5-5")
EFFORT = os.getenv("EFFORT", "medium")  # low | medium | high | xhigh | max
MAX_TURNS = int(os.getenv("MAX_TURNS", "25"))  # hard cap on model calls per user message
ENABLE_WEB_SEARCH = os.getenv("ENABLE_WEB_SEARCH", "1") == "1"

SYSTEM_PROMPT = """You are an autonomous agent built at a hackathon.
Work through the user's task end to end using your tools. Prefer acting over asking;
ask the user only when a decision is genuinely theirs. Before any action that changes
something outside this app, state what you are about to do in one sentence.
When you finish, give a short summary of what you did and the result."""

client = anthropic.AsyncAnthropic()


def _tool_defs() -> list[dict]:
    defs = [{**t.schema, "eager_input_streaming": True} for t in TOOLS.values()]
    if ENABLE_WEB_SEARCH:
        defs.append({"type": "web_search_20260209", "name": "web_search", "max_uses": 5})
    return defs


async def run_agent(messages: list) -> AsyncIterator[dict]:
    """Run the agent on `messages` (mutated in place with the new turns).

    Yields events: {"type": "text"|"thinking"|"tool_call"|"tool_result"|"server_tool"|"error"|"done", ...}
    """
    json_retries = 0
    for _ in range(MAX_TURNS):
        try:
            async with client.beta.messages.stream(
                model=MODEL,
                max_tokens=64000,
                system=SYSTEM_PROMPT,
                thinking={"type": "adaptive", "display": "summarized"},
                output_config={"effort": EFFORT},
                tools=_tool_defs(),
                messages=messages,
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default"},  # re-run declined requests on a fallback model
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_start":
                        block = event.content_block
                        if block.type == "server_tool_use":
                            yield {"type": "server_tool", "name": block.name}
                    elif event.type == "content_block_delta":
                        if event.delta.type == "text_delta":
                            yield {"type": "text", "text": event.delta.text}
                        elif event.delta.type == "thinking_delta":
                            yield {"type": "thinking", "text": event.delta.thinking}
                response = await stream.get_final_message()
            json_retries = 0
        except ValueError:
            # Tool input JSON the SDK couldn't parse at all; re-issue the turn (bounded).
            json_retries += 1
            if json_retries > 2:
                yield {"type": "error", "text": "Model produced unparseable tool input three times."}
                return
            continue
        except anthropic.RateLimitError:
            yield {"type": "error", "text": "Rate limited - wait a few seconds and retry."}
            return
        except anthropic.APIStatusError as e:
            yield {"type": "error", "text": f"API error {e.status_code}: {e.message}"}
            return
        except anthropic.APIConnectionError:
            yield {"type": "error", "text": "Connection to the Claude API failed."}
            return

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "pause_turn":  # long server-tool turn; send it back to continue
            continue
        if response.stop_reason == "refusal":
            yield {"type": "error", "text": "The model declined this request."}
            break

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            break
        if response.stop_reason == "max_tokens":
            yield {"type": "error", "text": "Output hit max_tokens mid tool call."}
            break

        async def _call(block):
            yield_event = {"type": "tool_call", "name": block.name, "input": block.input}
            problem = validate_input(block.name, block.input)
            if problem:
                return yield_event, {"type": "tool_result", "tool_use_id": block.id,
                                     "content": problem, "is_error": True}
            ok, output = await run_tool(block.name, block.input)
            return yield_event, {"type": "tool_result", "tool_use_id": block.id,
                                 "content": output, "is_error": not ok}

        # Run this turn's tool calls in parallel, return all results in one user message.
        pairs = await asyncio.gather(*(_call(b) for b in tool_uses))
        results = []
        for call_event, result in pairs:
            yield call_event
            yield {"type": "tool_result", "name": call_event["name"],
                   "output": result["content"][:2000], "is_error": result["is_error"]}
            results.append(result)
        messages.append({"role": "user", "content": results})
    else:
        yield {"type": "error", "text": f"Stopped after MAX_TURNS={MAX_TURNS}."}

    yield {"type": "done"}


def to_jsonable(messages: list) -> str:
    """Debug helper: dump the conversation (SDK blocks included) as JSON."""
    def conv(x):
        return x.model_dump() if hasattr(x, "model_dump") else x
    return json.dumps(messages, default=conv, indent=2)
