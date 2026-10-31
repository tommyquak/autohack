"""Agent core: the operator copilot's streaming tool-use loop, yielding UI-friendly events.

Tools live in tools.py. When Claude is unavailable, server.py answers from the deterministic router in
fallback.py instead (same NDJSON event types).
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
ENABLE_WEB_SEARCH = os.getenv("ENABLE_WEB_SEARCH", "0") == "1"  # copilot answers from the reports only

SYSTEM_PROMPT = """You are a conjunction-assessment copilot for a satellite operator's analyst. You answer questions
about the close-approach events in the current triage report (one event = one series of CDMs for a pair of objects).

Grounding
- Call tools before stating any number. Every number you write (counts, distances, Pc, days, percentages, rates)
  must appear in a tool result from this conversation. If no tool gives it, say you do not have it.
- Cite event ids for every event you mention ("event 482").
- Start overview questions with get_summary; use list_events to find events, get_event or explain_event for one
  event, compare_events for several, get_metrics for model performance (scored per CDM on the test split).

Wording
- Tier 0 is "below threshold". Never call an event or the situation "safe" (no "safe", "safety", "safely");
  below threshold only means the event is under the alert thresholds in this data.
- Never recommend or rule out a manoeuvre, and do not say one is or is not needed: the operator decides. You can
  describe what the data shows and which events an analyst may want to look at first.
- Repeat cautions in plain words: needs_review (the pipeline is not confident), no_covariance (a placeholder sigma,
  so Pc is unreliable by itself), pc_diluted (uncertainty is large compared with the miss distance, so a low Pc may
  reflect poor tracking rather than real separation).

Missing data
- Say plainly when the data cannot answer. In this dataset no event has a CDM closer than about 2 days to TCA
  (get_summary data_notes gives the exact value), so "within 24 hours" questions have no events; say that rather
  than widening the window silently. Labels (true tiers) are evaluation-only and are not in the event tools.

Dashboard
- When your answer is about a specific event, call focus_event once on the single most relevant one so the
  dashboard selects it. Do not call it for broad overviews.

Style: short, direct answers for an analyst; lead with the answer, then the supporting numbers. Plain text,
short lists are fine, no headings."""

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
                return yield_event, {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": problem,
                    "is_error": True,
                }
            ok, output = await run_tool(block.name, block.input)
            return yield_event, {"type": "tool_result", "tool_use_id": block.id, "content": output, "is_error": not ok}

        # Run this turn's tool calls in parallel, return all results in one user message.
        pairs = await asyncio.gather(*(_call(b) for b in tool_uses))
        results = []
        for call_event, result in pairs:
            yield call_event
            yield {
                "type": "tool_result",
                "name": call_event["name"],
                "output": result["content"][:2000],
                "is_error": result["is_error"],
            }
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
