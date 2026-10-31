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

import anthropic

from triage.features import SIGMA_SENTINEL_M
from triage.tiers import MISS_ELEVATED_M, RISK_CRITICAL, RISK_ELEVATED, TIER_NAMES

LLM_TIMEOUT_S = 20.0
# Pc peaks when the combined position sigma is about miss/sqrt(2); with a larger sigma, Pc falls
# because of uncertainty, not because the objects are further apart ("probability dilution").
DILUTION_RATIO = 1 / math.sqrt(2)
CAUTIONS = ("needs_review", "no_covariance", "pc_diluted")
BANNED = re.compile(r"\bsafe(ly|ty)?\b", re.IGNORECASE)  # tier 0 is "below threshold", never "safe"
# What needs_review means to a human. On a kept demotion candidate it marks a CLOSE CALL just above the demotion bar:
# on train CV only 2.0% of these are truly Elevated (32.1% for the other kept candidates), so it is mostly an
# over-warning, not the riskiest row. Otherwise it means an input (covariance, Pc, miss, sigma, type) is unusable.
REVIEW_TEXT = {
    "close_call": "close call: near the demotion bar, likely over-warning; analyst can clear (needs review)",
    "input": "needs review: an input is missing or unreliable, so the model did not act on it; a human should check it",
}
# The operator decides on a manoeuvre; the explanation must not advise one either way.
ADVICE = re.compile(r"\b(manoeuv\w*|maneuv\w*|burn|recommend\w*|should (move|act|wait))\b", re.IGNORECASE)
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")

SYSTEM_PROMPT = """You write short explanations of satellite conjunction (close-approach) events for
spacecraft operators. You receive a JSON object of facts that a deterministic risk pipeline
produced. Write 3-5 plain sentences that:
- state the tier and the main reason it was assigned;
- give the time to closest approach and the miss distance;
- describe the trend across updates if one is given;
- if `demoted` is true, say that the threshold rule gave `baseline_tier` (for the `reasons`) and Second Look
  demoted the event to `tier`; do not describe the event as `tier` "because of" those reasons;
- if `forecast` is given, say what tier the event is forecast to end at by closest approach (and, if `raised`, that
  it is forecast to rise from `tier` and the first of its `reasons`); call it a forecast, never a certainty;
- repeat any caution in `cautions` (close call / needs review, probability dilution, missing uncertainty) in plain
  words; a close call is most likely an over-warning, so do not describe it as the riskiest case.
Rules: use only numbers that appear in the facts. Never call an event "safe" - the lowest tier
is "below threshold". Do not mention manoeuvres, burns or recommendations at all; that is the operator's decision, and
any such wording is rejected.
No headings, lists or markdown."""


def cautions(event: dict) -> list[str]:
    """Caution codes for one event (events.json `cautions`): needs_review, no_covariance, pc_diluted."""
    latest = event["latest"]
    sigmas = latest["sigma_r_m"]["chaser"], latest["sigma_r_m"]["target"]
    out = ["needs_review"] if event["needs_review"] else []
    if max(sigmas) > SIGMA_SENTINEL_M:  # dataset placeholder: no usable covariance
        out.append("no_covariance")
    elif (
        math.hypot(*sigmas) > DILUTION_RATIO * latest["miss_distance_m"]
        and latest["max_risk_estimate_log10"] < RISK_CRITICAL
    ):
        out.append("pc_diluted")
    return out


def review_kind(event: dict, codes: list[str] | set[str]) -> str | None:
    """Why an event needs review: "close_call" (kept Pc-only Elevated candidate near the bar), "input", or None."""
    if not event.get("needs_review") and "needs_review" not in codes:
        return None
    latest = event["latest"]
    miss, pc_log = latest["miss_distance_m"], latest["max_risk_estimate_log10"]
    sigmas = latest["sigma_r_m"]["chaser"], latest["sigma_r_m"]["target"]
    usable = (
        all(v is not None and math.isfinite(v) for v in (miss, pc_log, *sigmas)) and max(sigmas) <= SIGMA_SENTINEL_M
    )
    pc_only_elevated = usable and miss > MISS_ELEVATED_M and RISK_ELEVATED <= pc_log < RISK_CRITICAL
    return "close_call" if pc_only_elevated and "no_covariance" not in codes else "input"


def facts(event: dict) -> dict:
    """The only information the explanation may use: fields already present in events.json."""
    latest = event["latest"]
    miss = latest["miss_distance_m"]
    pc_log = latest["max_risk_estimate_log10"]
    sigma = math.hypot(latest["sigma_r_m"]["chaser"], latest["sigma_r_m"]["target"])
    codes = event.get("cautions") or cautions(event)
    no_covariance, diluted = "no_covariance" in codes, "pc_diluted" in codes

    cautions_text = []
    review = review_kind(event, codes)
    if review:
        cautions_text.append(REVIEW_TEXT[review])
    if no_covariance:
        cautions_text.append(
            "no usable position uncertainty: the data reports its ceiling value for at least one object, "
            "so the Pc estimate should not be relied on by itself; the miss-distance rule still applies"
        )
    elif diluted:
        cautions_text.append(
            f"probability dilution: combined radial position uncertainty ({_dist(sigma)}) is large compared with the "
            f"miss distance ({_dist(miss)}), so a low Pc may reflect poor tracking rather than real separation"
        )

    baseline = event.get("baseline_tier", event["tier"])
    out = {
        "event_id": event["event_id"],
        "tier": event["tier_name"],
        "baseline_tier": TIER_NAMES.get(baseline, str(baseline)),
        "demoted": baseline > event["tier"],
        "reasons": event["reasons"],
        "time_to_tca": f"{latest['time_to_tca_days']:.1f} days",
        "miss_distance": _dist(miss),
        "relative_speed": f"{latest['relative_speed_ms'] / 1000:.1f} km/s",
        "pc_upper_bound": _pc(pc_log),
        "object_type": latest["object_type"].lower(),
        "combined_sigma_r": None if no_covariance else _dist(sigma),
        "no_covariance": no_covariance,
        "diluted": diluted,
        "cautions": cautions_text,
    }
    history = event.get("history") or []
    if len(history) >= 2:
        first, last = history[0], history[-1]
        out["trend"] = {
            "updates": len(history),
            "miss_distance": f"{_dist(first['miss_distance_m'])} -> {_dist(last['miss_distance_m'])}",
            "pc_upper_bound": f"{_pc(first['max_risk_estimate_log10'])} -> {_pc(last['max_risk_estimate_log10'])}",
            "closing": last["miss_distance_m"] < first["miss_distance_m"],
        }
    if fc := event.get("forecast"):  # final-tier forecast from updates 2+ days out (triage.forecast, docs/FORECAST.md)
        out["forecast"] = {
            "final_tier": fc["predicted_final_tier_name"],
            "raised": fc["predicted_final_tier"] > event["tier"],
            "reasons": fc.get("reasons", [])[:2],  # p_final scores are uncalibrated, so they are left out on purpose
        }
    return out


def template_explanation(f: dict) -> str:
    """Deterministic fallback text built from `facts()`."""
    why = "; ".join(f["reasons"])
    if f.get("demoted"):
        why = why.replace(
            "in [1e-6, 1e-4) (elevated band)", "in the elevated band"
        )  # the reasons are why the RULE fired, not why the event is at its (lower) tier
        first = (
            f"The rule gave {_tier_in_sentence(f['baseline_tier'])} ({why}); "
            f"Second Look demoted it to {_tier_in_sentence(f['tier'])}."
        )
    else:
        first = f"Event {f['event_id']} is {f['tier']} ({why})."
    parts = [
        first,
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
    if fc := f.get("forecast"):
        final = _tier_in_sentence(fc["final_tier"])
        parts.append(
            f"Forecast for closest approach, from updates two or more days out: {final}, raised from "
            f"{_tier_in_sentence(f['tier'])} ({fc['reasons'][0] if fc['reasons'] else 'model escalation'})."
            if fc["raised"]
            else f"Forecast for closest approach, from updates two or more days out: stays {final}."
        )
    parts += [c[0].upper() + c[1:] + "." for c in f["cautions"]]
    return " ".join(parts)


def check(text: str, f: dict) -> str | None:
    """Why Claude's text can't be shown (None if it can). Enforced in code, not only asked for in the prompt:
    no "safe", no manoeuvre advice, and every number must already appear in the facts."""
    if BANNED.search(text):
        return 'says "safe"'
    if m := ADVICE.search(text):
        return f'gives manoeuvre advice ("{m.group(0)}")'
    known = {n.replace(",", "") for n in NUMBER.findall(json.dumps(f))}
    if unknown := sorted({n.replace(",", "") for n in NUMBER.findall(text)} - known):
        return f"has numbers not in the facts ({', '.join(unknown[:3])})"
    return None


async def explain(event: dict, use_llm: bool = True) -> dict:
    f = facts(event)
    out = {"text": template_explanation(f), "source": "template", "facts": f}
    if use_llm and _has_credentials():
        text = await _claude(f)
        if text and not (reason := check(text, f)):
            return {"text": text, "source": "claude", "facts": f}
        if text:
            out["claude_rejected"] = reason  # shown text is the template; this says why Claude's was thrown out
    return out


async def _claude(f: dict) -> str | None:
    """Claude's wording of the facts (unchecked; `check` decides), or None if the call failed."""
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
    return "".join(b.text for b in response.content if b.type == "text").strip() or None


def _has_credentials() -> bool:
    """True when the SDK has something to authenticate with: a real ANTHROPIC_API_KEY (not the placeholder or test
    key), an ANTHROPIC_AUTH_TOKEN, or a profile / workload-identity configuration it would discover on its own.
    An unset or empty key with none of those means every Claude call would fail, so /health must say "fallback"."""
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if key:
        return not (key.endswith("...") or key == "sk-ant-test")
    if os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip():
        return True
    return _sdk_discovers_credentials()


def _sdk_discovers_credentials() -> bool:
    """Profile or federation credentials the SDK resolves without an env key (ANTHROPIC_PROFILE, an active or default
    profile under the config dir, ANTHROPIC_IDENTITY_TOKEN + federation ids). False if the SDK has no such support."""
    try:
        from anthropic.lib.credentials import _constants as c
    except ImportError:
        return False
    try:
        if c._has_auto_discoverable_credentials():
            return True
        return (c._config_dir() / "configs" / f"{c.DEFAULT_PROFILE}.json").is_file()
    except Exception:  # private SDK helpers; any change there means "not configured"
        return False


def _tier_in_sentence(name: str) -> str:
    return "below threshold" if name == TIER_NAMES[0] else name


def _pc(log10: float) -> str:
    """Pc as people write it, matching the dashboard: -4.38 -> "4.2e-5" (not "1e-4.4")."""
    if log10 is None or not math.isfinite(log10):
        return "unknown"
    e = math.floor(log10)
    m = round(10 ** (log10 - e), 1)
    if m >= 10:
        m, e = 1.0, e + 1
    return f"{m:.1f}e{e}"


def _dist(m: float) -> str:
    return f"{m:.0f} m" if m < 10_000 else f"{m / 1000:,.0f} km"
