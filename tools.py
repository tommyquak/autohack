"""Tools the copilot can call. Add one by writing a typed, documented function
and decorating it with @tool - the JSON schema is generated from the signature
(`int | None = None` becomes an optional field that also accepts null; `list[int]` an integer array).

    @tool
    def get_event(event_id: int) -> dict:
        "One conjunction event with its CDM history."
        ...

Mark anything with real-world side effects as @tool(side_effect=True): it is
blocked unless AUTO_APPROVE=1, so a demo never fires something you didn't mean to.

The triage tools below only read the pipeline's reports (triage/reports.py). Every number the copilot states
must come from one of them; the local fallback (fallback.py) calls the same functions, so both paths agree.
"""

import asyncio
import inspect
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from types import UnionType
from typing import Union, get_args, get_origin, get_type_hints

from triage import explain, reports
from triage.features import SIGMA_SENTINEL_M
from triage.tiers import TIER_NAMES

AUTO_APPROVE = os.getenv("AUTO_APPROVE", "0") == "1"
_PY_TO_JSON = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}
_JSON_TO_PY = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


@dataclass
class Tool:
    fn: Callable
    schema: dict
    side_effect: bool
    nullable: frozenset[str] = field(default_factory=frozenset)


TOOLS: dict[str, Tool] = {}


def _json_type(hint) -> tuple[dict, bool]:
    """JSON-schema fragment for a type hint, and whether the hint allows None."""
    nullable = False
    if get_origin(hint) in (Union, UnionType):
        args = [a for a in get_args(hint) if a is not type(None)]
        nullable = len(args) < len(get_args(hint))
        hint = args[0] if args else str
    origin = get_origin(hint) or hint
    spec = {"type": _PY_TO_JSON.get(origin, "string")}
    if origin is list and get_args(hint):
        spec["items"] = {"type": _PY_TO_JSON.get(get_args(hint)[0], "string")}
    return spec, nullable


def tool(fn=None, *, side_effect: bool = False):
    def register(f):
        hints = get_type_hints(f)
        props, required, nullable = {}, [], set()
        for name, param in inspect.signature(f).parameters.items():
            props[name], allows_none = _json_type(hints.get(name, str))
            if allows_none:
                nullable.add(name)
            if param.default is inspect.Parameter.empty:
                required.append(name)
        TOOLS[f.__name__] = Tool(
            fn=f,
            side_effect=side_effect,
            nullable=frozenset(nullable),
            schema={
                "name": f.__name__,
                "description": inspect.getdoc(f) or f.__name__,
                "input_schema": {"type": "object", "properties": props, "required": required},
            },
        )
        return f

    return register(fn) if fn else register


def _type_ok(val, json_type: str) -> bool:
    if json_type in ("integer", "number") and isinstance(val, bool):
        return False
    return isinstance(val, _JSON_TO_PY[json_type])


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
    for key, val in args.items():
        spec = schema["properties"].get(key)
        if spec is None:
            return f"INVALID_JSON: unexpected field {key!r}"
        if val is None and key in t.nullable:
            continue
        if not _type_ok(val, spec["type"]):
            return f"INVALID_JSON: field {key!r} should be {spec['type']}"
        if "items" in spec and not all(_type_ok(v, spec["items"]["type"]) for v in val):
            return f"INVALID_JSON: field {key!r} should be an array of {spec['items']['type']}"
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


# --- Triage tools (read-only) ----------------------------------------------------

MAX_LIST = 50
MAX_COMPARE = 10
METHODS = ("model", "max_risk_estimate_rule", "miss_distance_rule", "majority_class")
_CLASS_NAMES = ("Below threshold", "Elevated", "Critical")  # confusion-matrix order in metrics.json
_LABELS = {"SAFE": "Below threshold", "ELEVATED": "Elevated", "CRITICAL": "Critical"}  # never echo the raw label


def _round(x, nd: int):
    return None if x is None else round(float(x), nd)


def _event(event_id: int) -> dict:
    event = reports.events_by_id().get(event_id)
    if event is None:
        raise ValueError(f"event {event_id} is not in events.json ({reports.source()} copy)")
    return event


def _compact(e: dict) -> dict:
    """One event as a short row: the fields an analyst scans first."""
    latest = e["latest"]
    return {
        "event_id": e["event_id"],
        "tier_name": e["tier_name"],
        "baseline_tier": TIER_NAMES.get(e.get("baseline_tier", e["tier"]), str(e.get("baseline_tier"))),
        "time_to_tca_days": _round(latest["time_to_tca_days"], 2),
        "miss_distance_m": _round(latest["miss_distance_m"], 0),
        "pc_upper_log10": _round(latest["max_risk_estimate_log10"], 2),
        "object_type": latest["object_type"],
        "needs_review": e["needs_review"],
        "cautions": e.get("cautions") or explain.cautions(e),
        "reasons": e["reasons"],
    }


def _data_notes(events: list[dict]) -> dict:
    """Limits of the data that the copilot must state plainly instead of guessing around."""
    tca = [e["latest"]["time_to_tca_days"] for e in events]
    return {
        "earliest_latest_cdm_days_to_tca": _round(min(tca), 2) if tca else None,
        "latest_cdm_note": (
            "Each event's newest CDM is its latest information; the dataset has no CDM closer than "
            f"{min(tca):.2f} days to TCA, so nothing inside that window can be reported."
            if tca
            else "No events in the report."
        ),
        "placeholder_sigma_threshold_m": SIGMA_SENTINEL_M,
        "placeholder_sigma_note": (
            "A radial sigma above this threshold is the dataset's placeholder (about 63,781 km), meaning no usable "
            "covariance: caution code no_covariance. Pc for those events should not be relied on by itself."
        ),
    }


@tool
def get_summary() -> dict:
    """Overall triage picture of the current report: number of events, counts per tier (model and the conservative
    baseline rule), needs-review count, caution counts, the 24-hour warning window, events by object type, and data
    notes (e.g. how close to TCA the data goes). Call this before quoting any count."""
    data = reports.load_report("events.json")
    events = data["events"]
    by_object: dict[str, int] = {}
    for e in events:
        by_object[e["latest"]["object_type"]] = by_object.get(e["latest"]["object_type"], 0) + 1
    return {
        "report_source": reports.source(),
        **data["summary"],
        "demoted_by_model": sum(e.get("baseline_tier", e["tier"]) > e["tier"] for e in events),
        "by_object_type": by_object,
        "tier_order": "Critical > Elevated > Below threshold (tier 0 is 'below threshold', not a clearance)",
        "data_notes": _data_notes(events),
    }


@tool
def list_events(
    tier: int | None = None,
    needs_review: bool | None = None,
    max_days_to_tca: float | None = None,
    object_type: str | None = None,
    caution: str | None = None,
    limit: int = 10,
) -> dict:
    """List events most urgent first (tier, then soonest TCA) as compact rows. Filters (all optional):
    tier 0=Below threshold, 1=Elevated, 2=Critical; needs_review true/false; max_days_to_tca keeps events whose latest
    CDM is at most this many days before TCA; object_type e.g. DEBRIS, PAYLOAD, ROCKET BODY, UNKNOWN; caution keeps
    events carrying that caution code: needs_review, no_covariance (placeholder sigma, Pc unreliable by itself) or
    pc_diluted. `limit` rows (default 10, max 50); `total_matching` is the full count."""
    if caution is not None and caution not in explain.CAUTIONS:
        raise ValueError(f"unknown caution {caution!r}; use one of {list(explain.CAUTIONS)}")
    events = reports.load_report("events.json")["events"]
    if tier is not None:
        events = [e for e in events if e["tier"] == tier]
    if needs_review is not None:
        events = [e for e in events if e["needs_review"] == needs_review]
    if max_days_to_tca is not None:
        events = [e for e in events if e["latest"]["time_to_tca_days"] <= max_days_to_tca]
    if object_type:
        want = object_type.strip().upper()
        events = [e for e in events if e["latest"]["object_type"].upper() == want]
    if caution is not None:
        events = [e for e in events if caution in (e.get("cautions") or explain.cautions(e))]
    limit = max(1, min(int(limit), MAX_LIST))
    out = {
        "filters": {
            "tier": TIER_NAMES.get(tier) if tier is not None else None,
            "needs_review": needs_review,
            "max_days_to_tca": max_days_to_tca,
            "object_type": object_type,
            "caution": caution,
        },
        "total_matching": len(events),
        "returned": min(limit, len(events)),
        "events": [_compact(e) for e in events[:limit]],
    }
    if not events and max_days_to_tca is not None:
        notes = _data_notes(reports.load_report("events.json")["events"])
        if notes["earliest_latest_cdm_days_to_tca"] and max_days_to_tca < notes["earliest_latest_cdm_days_to_tca"]:
            out["note"] = notes["latest_cdm_note"]
    return out


@tool
def get_event(event_id: int) -> dict:
    """One event in detail: tier, baseline tier, confidence, reasons, cautions, latest CDM (miss distance, relative
    speed, RTN offset, radial sigmas with placeholder flags, Pc upper bound) and a compact history of every CDM
    (days to TCA, miss distance, Pc upper bound, model tier, baseline tier)."""
    e = _event(event_id)
    latest = e["latest"]
    sig = latest["sigma_r_m"]
    history = e.get("history") or []
    return {
        **_compact(e),
        "confidence": _round(e["confidence"], 2),
        "relative_speed_ms": _round(latest["relative_speed_ms"], 0),
        "relative_position_rtn_m": latest.get("relative_position_rtn_m"),
        "sigma_r_m": {
            k: {"value": _round(sig[k], 1), "placeholder": sig[k] > SIGMA_SENTINEL_M} for k in ("chaser", "target")
        },
        "n_updates": len(history),
        "history": [
            {
                "days_to_tca": _round(h["time_to_tca_days"], 2),
                "miss_m": _round(h["miss_distance_m"], 0),
                "pc_upper_log10": _round(h["max_risk_estimate_log10"], 2),
                "tier": TIER_NAMES.get(h.get("pred_tier"), h.get("pred_tier")),
                "baseline_tier": TIER_NAMES.get(h.get("baseline_tier"), h.get("baseline_tier")),
            }
            for h in history
        ],
    }


@tool
def get_metrics(method: str = "model") -> dict:
    """Evaluation on the held-out test split (scored per CDM): Critical recall and precision, false-alarm rate
    (share of non-Critical CDMs flagged Critical), macro-F1, flagged rate, under-tier rate, confusion matrix and the
    same by lead time. `method` is one of model, max_risk_estimate_rule, miss_distance_rule, majority_class."""
    data = reports.load_report("metrics.json")
    results = data.get("results", {})
    if method not in results:
        raise ValueError(f"unknown method {method!r}; available: {sorted(results)}")

    def scores(r: dict) -> dict:
        out = {k: (_round(v, 6) if isinstance(v, float) else v) for k, v in r.items() if k != "confusion"}
        if "confusion" in r:
            out["confusion"] = {
                "order": list(_CLASS_NAMES),
                "rows_truth_cols_prediction": r["confusion"],
            }
        return out

    return {
        "split": data.get("split"),
        "method": method,
        "available_methods": [m for m in METHODS if m in results] + [m for m in results if m not in METHODS],
        "class_counts": {_LABELS.get(k.upper(), k): v for k, v in (data.get("class_counts") or {}).items()},
        "scores": scores(results[method]),
        "by_lead_time": [scores(b) for b in data.get("by_lead_time", {}).get(method, [])],
        "missed_criticals": len(data.get("missed_criticals") or []) if method == "model" else None,
    }


@tool
def explain_event(event_id: int) -> dict:
    """Plain-English explanation of one event built deterministically from its facts (tier, reasons, TCA, miss
    distance, Pc upper bound, trend across updates, cautions). Quote or paraphrase `text`; it adds no new numbers."""
    f = explain.facts(_event(event_id))
    return {"event_id": event_id, "text": explain.template_explanation(f), "source": "template", "facts": f}


@tool
def compare_events(event_ids: list[int]) -> dict:
    """Side-by-side compact rows for 2-10 events (same fields as list_events, plus confidence, n_updates and the
    first-to-latest miss-distance change). Unknown ids are listed in `not_found`."""
    by_id = reports.events_by_id()
    rows, missing = [], []
    for eid in list(dict.fromkeys(event_ids))[:MAX_COMPARE]:
        e = by_id.get(eid)
        if e is None:
            missing.append(eid)
            continue
        history = e.get("history") or []
        row = {**_compact(e), "confidence": _round(e["confidence"], 2), "n_updates": len(history)}
        if len(history) >= 2:
            row["miss_first_to_latest_m"] = [
                _round(history[0]["miss_distance_m"], 0),
                _round(history[-1]["miss_distance_m"], 0),
            ]
        rows.append(row)
    return {"events": rows, "not_found": missing}


@tool
def focus_event(event_id: int) -> dict:
    """Select this event on the operator's dashboard (opens its detail and 3D close-approach view). Call it once for
    the single most relevant event whenever an answer is about a specific event."""
    _event(event_id)  # never point the UI at an event that does not exist
    return {"focus": event_id}
