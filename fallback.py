"""Local fallback for the copilot: a small deterministic intent router used when Claude is unavailable.

It calls the same functions in tools.py that Claude calls, so every number it prints comes from the reports.
`answer(message)` returns (text, focus_event_id | None); `events(message)` turns that into the chat's NDJSON
events: text chunks, a focus_event tool_call when one event is the subject, then done.

Intents, checked in this order:
    "compare 482 and 17"                    -> compare_events
    "event 482" / "#482"                    -> explain_event (template) + focus_event
    recall / precision / false alarm / ...  -> get_metrics (model vs the two rule baselines)
    critical / elevated / below threshold / needs review / within N days|hours / debris ... -> list_events
    summary / how many / overview / status  -> get_summary
    anything else                           -> what this mode can answer
"""

import re

import tools
from triage.tiers import TIER_NAMES

LIST_LIMIT = 5
_EVENT_RE = re.compile(r"(?:\bevent\s*(?:id\s*)?#?\s*|#)(\d+)\b", re.IGNORECASE)
_DAYS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?)\b", re.IGNORECASE)
_OBJECTS = {"debris": "DEBRIS", "payload": "PAYLOAD", "rocket body": "ROCKET BODY", "unknown object": "UNKNOWN"}
_CAUTION_TEXT = {
    "needs_review": "needs review",
    "no_covariance": "no usable covariance (placeholder sigma)",
    "pc_diluted": "possible Pc dilution",
}
HELP = (
    "I'm answering in local mode (deterministic, no language model), so I can handle these questions about the "
    "current triage report:\n"
    '- the overall summary and tier counts ("summary", "how many events need review?")\n'
    "- lists of Critical, Elevated, below-threshold or needs-review events, by object type or within N days of TCA "
    '("critical debris within 3 days")\n'
    '- one event in plain English ("event 482")\n'
    '- a side-by-side comparison ("compare 482 and 17")\n'
    '- how the model scores against the rule baselines ("recall", "false alarms")\n'
    "Tier decisions come from the pipeline; whether to manoeuvre is the operator's decision."
)


def _pct(x: float | None, nd: int = 1) -> str:
    return "n/a" if x is None else f"{x * 100:.{nd}f}%"


def _row(e: dict) -> str:
    line = (
        f"- Event {e['event_id']}: {e['tier_name']} (baseline {e['baseline_tier']}), {e['object_type'].lower()}, "
        f"TCA in {e['time_to_tca_days']:.1f} d, miss {e['miss_distance_m']:,.0f} m, "
        f"Pc upper bound 1e{e['pc_upper_log10']:.1f}"
    )
    if e["cautions"]:
        line += "; " + ", ".join(_CAUTION_TEXT.get(c, c) for c in e["cautions"])
    return line


def _summary() -> tuple[str, None]:
    s = tools.get_summary()
    tiers, base, cautions = s["by_tier"], s.get("by_baseline_tier") or {}, s.get("cautions") or {}
    notes = s["data_notes"]
    lines = [
        f"The current report ({s['report_source']} copy) has {s['n_events']:,} events: "
        f"{tiers.get('Critical', 0):,} Critical, {tiers.get('Elevated', 0):,} Elevated and "
        f"{tiers.get('Below threshold', 0):,} below threshold.",
        f"{s['needs_review']:,} need review; {cautions.get('no_covariance', 0):,} have no usable covariance "
        f"(placeholder sigma) and {cautions.get('pc_diluted', 0):,} show possible Pc dilution.",
    ]
    if base:
        lines.append(
            f"The conservative baseline rule gives {base.get('Critical', 0):,} Critical, "
            f"{base.get('Elevated', 0):,} Elevated and {base.get('Below threshold', 0):,} below threshold; "
            f"the model demoted {s['demoted_by_model']:,} events and never promotes."
        )
    w = s.get("warnings_24h")
    if w:
        lines.append(
            f"Within {w['window_days']:g} day of TCA: {w['events_in_window']:,} events "
            f"({w['critical_in_window']:,} Critical). {notes['latest_cdm_note']}"
        )
    return "\n".join(lines), None


def _filters(text: str) -> dict:
    low = text.lower()
    f: dict = {}
    if "critical" in low:
        f["tier"] = 2
    elif "elevated" in low:
        f["tier"] = 1
    elif re.search(r"below[- ]threshold|\bsafe\b|tier 0|lowest tier", low):
        f["tier"] = 0
    if re.search(r"review|uncertain|not confident", low):
        f["needs_review"] = True
    if m := _DAYS_RE.search(low):
        n, unit = float(m.group(1)), m.group(2)
        f["max_days_to_tca"] = n / 24 if unit.startswith("h") else n
    elif re.search(r"\btoday\b|\bnext day\b", low):
        f["max_days_to_tca"] = 1.0
    for word, code in _OBJECTS.items():
        if word in low:
            f["object_type"] = code
    return f


def _describe(f: dict) -> str:
    parts = []
    if "tier" in f:
        parts.append(TIER_NAMES[f["tier"]])
    if f.get("needs_review"):
        parts.append("needs review")
    if "object_type" in f:
        parts.append(f["object_type"].lower())
    if "max_days_to_tca" in f:
        days = f["max_days_to_tca"]
        parts.append(f"latest CDM within {days:g} {'day' if days == 1 else 'days'} of TCA")
    return ", ".join(parts)


def _list(f: dict) -> tuple[str, int | None]:
    out = tools.list_events(**f, limit=LIST_LIMIT)
    total, rows = out["total_matching"], out["events"]
    head = f"{total:,} events match ({_describe(f)})."
    if not rows:
        return head + (" " + out["note"] if "note" in out else ""), None
    shown = "the most urgent" if total == 1 else f"the {len(rows)} most urgent"
    body = "\n".join(_row(e) for e in rows)
    return f"{head} Showing {shown}, ordered by tier then soonest TCA:\n{body}", rows[0]["event_id"]


def _event(event_id: int) -> tuple[str, int | None]:
    try:
        out = tools.explain_event(event_id)
    except ValueError:
        return f"Event {event_id} is not in the current report.", None
    return out["text"], event_id


def _compare(ids: list[int]) -> tuple[str, int | None]:
    out = tools.compare_events(ids)
    lines = [_row(e) for e in out["events"]]
    if out["not_found"]:
        lines.append("Not in the current report: " + ", ".join(str(i) for i in out["not_found"]))
    if not out["events"]:
        return "\n".join(lines), None
    return "Side by side:\n" + "\n".join(lines), out["events"][0]["event_id"]


def _metrics() -> tuple[str, None]:
    m = tools.get_metrics("model")["scores"]
    lines = [
        f"On the held-out test split ({m['n']:,} CDMs, scored per CDM) the model's Critical recall is "
        f"{_pct(m['critical_recall'])}, precision {_pct(m['critical_precision'])}, false-alarm rate "
        f"{_pct(m['false_alarm_rate'], 2)} (non-Critical CDMs flagged Critical), macro-F1 {m['macro_f1']:.3f}, "
        f"flagged rate {_pct(m['flagged_rate'])}, under-tier rate {_pct(m['under_tier_rate'], 3)}.",
    ]
    for method, label in (("max_risk_estimate_rule", "Pc-upper-bound rule"), ("miss_distance_rule", "Miss rule")):
        try:
            b = tools.get_metrics(method)["scores"]
        except ValueError:
            continue
        lines.append(
            f"{label} for comparison: recall {_pct(b['critical_recall'])}, false alarms "
            f"{_pct(b['false_alarm_rate'], 2)}, flagged {_pct(b['flagged_rate'])}, macro-F1 {b['macro_f1']:.3f}."
        )
    return "\n".join(lines), None


def answer(message: str) -> tuple[str, int | None]:
    """Deterministic reply to one chat message: (text, event id to focus or None)."""
    low = message.lower()
    numbers = [int(n) for n in re.findall(r"\b\d+\b", message)]
    if "compare" in low and len(numbers) >= 2:
        return _compare(numbers)
    if m := _EVENT_RE.search(message):
        return _event(int(m.group(1)))
    if re.search(r"recall|precision|false[- ]alarm|metric|f1|accura|perform|baseline|evaluat|miss(ed)? critical", low):
        return _metrics()
    if f := _filters(message):
        return _list(f)
    if re.search(r"summar|how many|count|overview|status|total|situation|picture|report", low):
        return _summary()
    return HELP, None


def events(message: str):
    """NDJSON events for one fallback answer (the same types the Claude path emits)."""
    try:
        text, focus = answer(message)
    except FileNotFoundError as e:  # reports missing entirely
        text, focus = f"The triage reports are not available: {e}", None
    for i, para in enumerate(text.split("\n")):
        yield {"type": "text", "text": ("\n" if i else "") + para}
    if focus is not None:
        yield {"type": "tool_call", "name": "focus_event", "input": {"event_id": focus}}
        yield {"type": "tool_result", "name": "focus_event", "output": f'{{"focus": {focus}}}', "is_error": False}
    yield {"type": "done"}
