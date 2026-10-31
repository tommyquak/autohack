"""Plain-English explanation of one event (owner: Integration & trust).

The tier always comes from the deterministic pipeline (`predict()` + rules). This module only
*describes* it. Claude rewrites a fixed set of facts into operator prose; if there is no API key,
the call fails, or the text breaks a wording rule, the template below is used instead, so the
demo never depends on the API.

    facts(event)                -> structured facts drawn only from events.json fields
    template_explanation(facts) -> deterministic text
    await explain(event)        -> {"text", "source": "claude"|"template", "facts"}
"""

import json
import math
import os
import re
from functools import cache
from pathlib import Path

import anthropic

from triage.tiers import RISK_CRITICAL

EVENTS_PATH = Path(__file__).resolve().parent.parent / "reports" / "events.json"
LLM_TIMEOUT_S = 20.0
# Pc peaks when the combined position sigma is about miss/sqrt(2); with a larger sigma, Pc falls
# because of uncertainty, not because the objects are further apart ("probability dilution").
DILUTION_RATIO = 1 / math.sqrt(2)
# The dataset caps missing/unusable sigmas at ~10 Earth radii (63,781,361-63,781,363 m, ~5% of test events).
SIGMA_CAP_M = 6.3e7
BANNED = re.compile(r"\bsafe(ly|ty)?\b", re.IGNORECASE)  # tier 0 is "below threshold", never "safe"

SYSTEM_PROMPT = """You write short explanations of satellite conjunction (close-approach) events for
spacecraft operators. You receive a JSON object of facts that a deterministic risk pipeline
produced. Write 3-5 plain sentences that:
- state the tier and the main reason it was assigned;
- give the time to closest approach and the miss distance;
- describe the trend across updates if one is given;
- repeat any caution in `cautions` (needs review, probability dilution, missing uncertainty) in plain words.
Rules: use only numbers that appear in the facts. Never call an event "safe" - the lowest tier
is "below threshold". Do not recommend or rule out a manoeuvre; that is the operator's decision.
No headings, lists or markdown."""


def facts(event: dict) -> dict:
    """The only information the explanation may use: fields already present in events.json."""
    latest = event["latest"]
    miss = latest["miss_distance_m"]
    pc_log = latest["max_risk_estimate_log10"]
    sigmas = latest["sigma_r_m"]["chaser"], latest["sigma_r_m"]["target"]
    sigma = math.hypot(*sigmas)
    no_covariance = max(sigmas) >= SIGMA_CAP_M

    cautions = []
    if event["needs_review"]:
        cautions.append("needs review: the estimate sits close to a threshold, so it is shown at the higher tier")
    diluted = not no_covariance and sigma > DILUTION_RATIO * miss and pc_log < RISK_CRITICAL
    if no_covariance:
        cautions.append(
            "no usable position uncertainty: the data reports its ceiling value for at least one object, "
            "so the Pc estimate should not be relied on by itself; the miss-distance rule still applies"
        )
    elif diluted:
        cautions.append(
            f"probability dilution: combined radial position uncertainty ({_dist(sigma)}) exceeds the "
            f"miss distance ({_dist(miss)}), so a low Pc may reflect poor tracking rather than real separation"
        )

    out = {
        "event_id": event["event_id"],
        "tier": event["tier_name"],
        "reasons": event["reasons"],
        "confidence": round(event["confidence"], 2),
        "time_to_tca": f"{latest['time_to_tca_days']:.1f} days",
        "miss_distance": _dist(miss),
        "relative_speed": f"{latest['relative_speed_ms'] / 1000:.1f} km/s",
        "pc_upper_bound": f"1e{pc_log:.1f}",
        "object_type": latest["object_type"].lower(),
        "combined_sigma_r": None if no_covariance else _dist(sigma),
        "no_covariance": no_covariance,
        "diluted": diluted,
        "cautions": cautions,
    }
    history = event.get("history") or []
    if len(history) >= 2:
        first, last = history[0], history[-1]
        out["trend"] = {
            "updates": len(history),
            "miss_distance": f"{_dist(first['miss_distance_m'])} -> {_dist(last['miss_distance_m'])}",
            "pc_upper_bound": f"1e{first['max_risk_estimate_log10']:.1f} -> 1e{last['max_risk_estimate_log10']:.1f}",
            "closing": last["miss_distance_m"] < first["miss_distance_m"],
        }
    return out


def template_explanation(f: dict) -> str:
    """Deterministic fallback text built from `facts()`."""
    parts = [
        f"Event {f['event_id']} is {f['tier']} ({'; '.join(f['reasons'])}).",
        f"Closest approach in {f['time_to_tca']} with a {f['object_type']} object: "
        f"predicted miss distance {f['miss_distance']} at {f['relative_speed']}, "
        f"Pc upper bound {f['pc_upper_bound']}.",
    ]
    if trend := f.get("trend"):
        direction = "closing" if trend["closing"] else "opening"
        parts.append(
            f"Over {trend['updates']} updates the miss distance went {trend['miss_distance']} ({direction}) "
            f"and the Pc upper bound went {trend['pc_upper_bound']}."
        )
    parts += [c[0].upper() + c[1:] + "." for c in f["cautions"]]
    return " ".join(parts)


async def explain(event: dict, use_llm: bool = True) -> dict:
    f = facts(event)
    if use_llm and _has_credentials():
        text = await _claude(f)
        if text:
            return {"text": text, "source": "claude", "facts": f}
    return {"text": template_explanation(f), "source": "template", "facts": f}


async def _claude(f: dict) -> str | None:
    """Claude's wording of the facts, or None so the caller falls back to the template."""
    from agent import MODEL, client  # imported lazily so the template path needs no client

    try:
        response = await client.with_options(timeout=LLM_TIMEOUT_S, max_retries=1).beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": json.dumps(f)}],
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
    except (anthropic.AnthropicError, TypeError):  # TypeError: SDK found no credentials at all
        return None
    if response.stop_reason != "end_turn":
        return None
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not text or BANNED.search(text):
        return None
    return text


def _has_credentials() -> bool:
    """False only for the placeholder/test keys; otherwise let the SDK resolve a key or `ant` profile."""
    key = os.getenv("ANTHROPIC_API_KEY", "")
    return not (key.endswith("...") or key == "sk-ant-test")


def _dist(m: float) -> str:
    return f"{m:.0f} m" if m < 10_000 else f"{m / 1000:,.0f} km"


@cache
def _events_by_id(path: Path, mtime: float) -> dict[int, dict]:
    return {e["event_id"]: e for e in json.loads(path.read_text())["events"]}


def load_event(event_id: int, path: Path = EVENTS_PATH) -> dict | None:
    """One event from events.json (re-read automatically when the file is rebuilt)."""
    if not path.exists():
        return None
    return _events_by_id(path, path.stat().st_mtime).get(event_id)
