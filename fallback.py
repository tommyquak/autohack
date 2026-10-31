"""Local fallback for the copilot: a small deterministic intent router used when Claude is unavailable.

It calls the same functions in tools.py that Claude calls, so every number it prints comes from a tool result.
`answer(message)` returns (text, focus_event_id | None); `traced(message)` also returns the tool calls it made;
`events(message)` turns that into the chat's NDJSON events: a tool_call + tool_result pair for every data tool it
called (so the UI and evaluators can see where each number came from), text chunks, a focus_event tool_call when one
event is the subject, then done.

Intents, checked in this order:
    "compare <id> and <id>"                 -> compare_events
    "event <id>" / "#<id>"                  -> explain_event (template) + focus_event
    demoted / demotion                      -> get_summary (model vs the conservative baseline rule)
    recall / precision / false alarm / missed Critical / raised to Elevated / CDMs ... -> get_metrics
    manoeuvre / maneuver (no event id)      -> the operator decides; Critical events for context (list_events)
    critical / elevated / below threshold / needs review / no covariance / within N days|hours / debris ...
                                            -> list_events
    summary / how many / overview / status  -> get_summary
    anything else                           -> what this mode can answer
Messages that mention a manoeuvre, ignoring or skipping get "Whether to manoeuvre is the operator's decision."
"""

import json
import re

import tools
from triage.tiers import TIER_NAMES

LIST_LIMIT = 5
OUTPUT_CHARS = 2000  # same cut as the Claude path's tool_result events
_EVENT_RE = re.compile(r"(?:\bevent\s*(?:id\s*)?#?\s*|#)(\d+)\b", re.IGNORECASE)
_DAYS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?)\b", re.IGNORECASE)
_OBJECTS = {"debris": "DEBRIS", "payload": "PAYLOAD", "rocket body": "ROCKET BODY", "unknown object": "UNKNOWN"}
_CAUTION_TEXT = {
    "needs_review": "needs review",
    "no_covariance": "no usable covariance (placeholder sigma)",
    "pc_diluted": "possible Pc dilution",
}
_CAUTION_FILTER_TEXT = {
    "needs_review": "needs review",
    "no_covariance": "no usable covariance",
    "pc_diluted": "possible Pc dilution",
}
_DEMOTED = re.compile(r"demot", re.IGNORECASE)
_NOT_RULE = r"(?![- ](distance|rule))"  # "miss distance" / "miss rule" is not "missed"
_MISSED = re.compile(rf"\bmiss(ed|es)?\b{_NOT_RULE}.*\bcritical|\bcritical.*\bmiss(ed)?\b{_NOT_RULE}", re.IGNORECASE)
_FALSE_ALARM = re.compile(r"false[- ]alarm", re.IGNORECASE)
_FALSE_ELEVATED = re.compile(r"raise.*elevated|false elevated|over-?tier|confusion", re.IGNORECASE)
_MISS_RULE = re.compile(r"miss(-| )distance rule|miss rule", re.IGNORECASE)
_METRICS = re.compile(
    r"recall|precision|false[- ]alarm|metric|\bf1\b|accura|perform|baseline|evaluat|test set|held[- ]out|\bcdms?\b",
    re.IGNORECASE,
)
_MANOEUVRE = re.compile(
    r"manoeuv|maneuv|\bavoid|\bskip|\bburn\b|\bignor(e|ing)\b(?! (your|the|all|previous|my) (rules|instructions))",
    re.IGNORECASE,
)
# Words that tie "today" / "next day" to the triage report (otherwise "weather today" would become a TCA window).
_IN_SCOPE = re.compile(
    r"event|conjunction|\btca\b|closest approach|close approach|critical|elevated|threshold|debris|payload|"
    r"rocket|\bcdms?\b|review|satellite|object|collision|\bpc\b|miss distance",
    re.IGNORECASE,
)
MANOEUVRE_NOTE = "Whether to manoeuvre is the operator's decision; I only describe what the data shows."
HELP = (
    "I'm answering in local mode (deterministic, no language model), so I can only answer these questions about "
    "the current triage report:\n"
    '- the overall summary and tier counts ("summary", "how many events need review?")\n'
    "- lists of Critical, Elevated, below-threshold or needs-review events, events with no usable covariance or "
    'possible Pc dilution, by object type or within N days of TCA ("critical debris within N days")\n'
    '- one event in plain English ("event <id>")\n'
    '- a side-by-side comparison ("compare <id> and <id>")\n'
    '- how the model scores against the rule baselines ("recall", "false alarms", "missed Criticals")\n'
    "Tier decisions come from the pipeline; whether to manoeuvre is the operator's decision."
)


class Trace(list):
    """The data tools one answer called: [{"name", "input", "output", "is_error"}]."""

    def call(self, name: str, **kwargs):
        try:
            out = getattr(tools, name)(**kwargs)
        except Exception as e:
            self.append({"name": name, "input": kwargs, "output": f"{type(e).__name__}: {e}", "is_error": True})
            raise
        self.append({"name": name, "input": kwargs, "output": out, "is_error": False})
        return out


def _pct(x: float | None, nd: int = 1) -> str:
    return "n/a" if x is None else f"{x * 100:.{nd}f}%"


def _tier_in_sentence(name: str) -> str:
    return "below threshold" if name == TIER_NAMES[0] else name


def _row(e: dict) -> str:
    line = (
        f"- Event {e['event_id']}: {e['tier_name']} (baseline {e['baseline_tier']}), {e['object_type'].lower()}, "
        f"TCA in {e['time_to_tca_days']:.1f} d, miss {e['miss_distance_m']:,.0f} m, "
        f"Pc upper bound 1e{e['pc_upper_log10']:.1f}"
    )
    if e["cautions"]:
        line += "; " + ", ".join(_CAUTION_TEXT.get(c, c) for c in e["cautions"])
    return line


def _summary(t: Trace) -> tuple[str, None]:
    s = t.call("get_summary")
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


def _demoted(t: Trace) -> tuple[str, None]:
    s = t.call("get_summary")
    tiers, base = s["by_tier"], s.get("by_baseline_tier") or {}
    text = (
        f"The model demoted {s['demoted_by_model']:,} events below the tier the conservative baseline rule gives; "
        "it never promotes an event above the baseline."
    )
    if base:
        text += (
            f"\nBaseline rule: {base.get('Critical', 0):,} Critical, {base.get('Elevated', 0):,} Elevated, "
            f"{base.get('Below threshold', 0):,} below threshold. Model: {tiers.get('Critical', 0):,} Critical, "
            f"{tiers.get('Elevated', 0):,} Elevated, {tiers.get('Below threshold', 0):,} below threshold."
        )
    return text, None


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
    if re.search(r"covariance|placeholder|sigma", low):
        f["caution"] = "no_covariance"
    elif re.search(r"dilut", low):
        f["caution"] = "pc_diluted"
    if m := _DAYS_RE.search(low):
        n, unit = float(m.group(1)), m.group(2)
        f["max_days_to_tca"] = n / 24 if unit.startswith("h") else n
    elif re.search(r"\btoday\b|\bnext day\b", low) and _IN_SCOPE.search(low):
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
    if "caution" in f:
        parts.append(_CAUTION_FILTER_TEXT[f["caution"]])
    if "object_type" in f:
        parts.append(f["object_type"].lower())
    if "max_days_to_tca" in f:
        days = f["max_days_to_tca"]
        parts.append(f"latest CDM within {days:g} {'day' if days == 1 else 'days'} of TCA")
    return ", ".join(parts)


def _list(t: Trace, f: dict) -> tuple[str, int | None]:
    out = t.call("list_events", **f, limit=LIST_LIMIT)
    total, rows = out["total_matching"], out["events"]
    head = f"{total:,} events match ({_describe(f)})."
    if not rows:
        return head + (" " + out["note"] if "note" in out else ""), None
    shown = "the most urgent" if total == 1 else f"the {len(rows)} most urgent"
    body = "\n".join(_row(e) for e in rows)
    return f"{head} Showing {shown}, ordered by tier then soonest TCA:\n{body}", rows[0]["event_id"]


def _event(t: Trace, event_id: int) -> tuple[str, int | None]:
    try:
        out = t.call("explain_event", event_id=event_id)
    except ValueError:
        return f"Event {event_id} is not in the current report.", None
    return out["text"], event_id


def _compare(t: Trace, ids: list[int]) -> tuple[str, int | None]:
    out = t.call("compare_events", event_ids=ids)
    lines = [_row(e) for e in out["events"]]
    if out["not_found"]:
        lines.append("Not in the current report: " + ", ".join(str(i) for i in out["not_found"]))
    if not out["events"]:
        return "\n".join(lines), None
    return "Side by side:\n" + "\n".join(lines), out["events"][0]["event_id"]


def _confusion(scores: dict) -> list[list[int]] | None:
    return (scores.get("confusion") or {}).get("rows_truth_cols_prediction")


def _metrics(t: Trace, message: str) -> tuple[str, None]:
    """Model scores plus the rule baselines; the line the question asks about comes first."""
    out = t.call("get_metrics", method="model")
    m = out["scores"]
    lines: dict[str, str] = {
        "model": (
            f"On the held-out test split ({m['n']:,} CDMs, scored per CDM) the model's Critical recall is "
            f"{_pct(m['critical_recall'])}, precision {_pct(m['critical_precision'])}, false-alarm rate "
            f"{_pct(m['false_alarm_rate'], 2)} (non-Critical CDMs flagged Critical), macro-F1 {m['macro_f1']:.3f}, "
            f"flagged rate {_pct(m['flagged_rate'])}, under-tier rate {_pct(m['under_tier_rate'], 3)}."
        )
    }
    conf = _confusion(m)
    if conf:
        crit = conf[2]
        n_crit = (out.get("class_counts") or {}).get("Critical")
        of = f"Of {n_crit:,} true-Critical CDMs" if isinstance(n_crit, int) else "Of the true-Critical CDMs"
        lines["missed"] = (
            f"Critical CDMs the model missed (true Critical, predicted lower): {out['missed_criticals']:,}. "
            f"{of}, the model put {crit[2]:,} in Critical, {crit[1]:,} in Elevated and {crit[0]:,} below threshold "
            "(confusion matrix, Critical row)."
        )
    rules = {}
    for method, label in (
        ("max_risk_estimate_rule", "Pc-upper-bound rule"),
        ("miss_distance_rule", "Miss-distance rule"),
    ):
        try:
            b = t.call("get_metrics", method=method)["scores"]
        except ValueError:
            continue
        rules[method] = b
        key = "miss_rule" if method == "miss_distance_rule" else "pc_rule"
        lines[key] = (
            f"{label} for comparison: Critical recall {_pct(b['critical_recall'])}, false alarms "
            f"{_pct(b['false_alarm_rate'], 2)}, flagged {_pct(b['flagged_rate'])}, macro-F1 {b['macro_f1']:.3f}."
        )
    pc_conf = _confusion(rules.get("max_risk_estimate_rule") or {})
    if conf and pc_conf:
        lines["false_elevated"] = (
            f"Below-threshold CDMs raised to Elevated: model {conf[0][1]:,} vs Pc-upper-bound rule {pc_conf[0][1]:,} "
            f"(raised to Critical: model {conf[0][2]:,} vs rule {pc_conf[0][2]:,})."
        )
    if _MISS_RULE.search(message):
        lead = ["miss_rule"]
    elif _MISSED.search(message):
        lead = ["missed"]
    elif _FALSE_ELEVATED.search(message):
        lead = ["false_elevated"]
    elif _FALSE_ALARM.search(message):
        lead = ["model", "pc_rule"]
    else:
        lead = ["model"]
    order = lead + [k for k in ("model", "missed", "false_elevated", "pc_rule", "miss_rule") if k not in lead]
    return "\n".join(lines[k] for k in order if k in lines), None


def _manoeuvre_overview(t: Trace) -> tuple[str, int | None]:
    text, focus = _list(t, {"tier": 2})
    return f"{MANOEUVRE_NOTE} For context, the Critical events in the current report:\n{text}", focus


def _route(message: str, t: Trace) -> tuple[str, int | None]:
    low = message.lower()
    numbers = [int(n) for n in re.findall(r"\b\d+\b", message)]
    if "compare" in low and len(numbers) >= 2:
        return _compare(t, numbers)
    if m := _EVENT_RE.search(message):
        return _event(t, int(m.group(1)))
    if _DEMOTED.search(low):
        return _demoted(t)
    if _METRICS.search(low) or _MISSED.search(low) or _FALSE_ELEVATED.search(low):
        return _metrics(t, message)
    if re.search(r"manoeuv|maneuv", low):
        return _manoeuvre_overview(t)
    if f := _filters(message):
        return _list(t, f)
    if re.search(r"summar|how many|count|overview|status|total|situation|picture|report", low):
        return _summary(t)
    return HELP, None


def traced(message: str) -> tuple[str, int | None, Trace]:
    """Deterministic reply to one chat message: (text, event id to focus or None, tool calls made)."""
    t = Trace()
    text, focus = _route(message, t)
    if _MANOEUVRE.search(message) and "operator's decision" not in text:
        text += "\n" + MANOEUVRE_NOTE
    return text, focus, t


def answer(message: str) -> tuple[str, int | None]:
    """Deterministic reply to one chat message: (text, event id to focus or None)."""
    text, focus, _ = traced(message)
    return text, focus


def events(message: str):
    """NDJSON events for one fallback answer (the same types the Claude path emits)."""
    try:
        text, focus, trace = traced(message)
    except FileNotFoundError as e:  # reports missing entirely
        text, focus, trace = f"The triage reports are not available: {e}", None, Trace()
    for c in trace:
        output = c["output"] if isinstance(c["output"], str) else json.dumps(c["output"], default=str)
        yield {"type": "tool_call", "name": c["name"], "input": c["input"]}
        yield {"type": "tool_result", "name": c["name"], "output": output[:OUTPUT_CHARS], "is_error": c["is_error"]}
    for i, para in enumerate(text.split("\n")):
        yield {"type": "text", "text": ("\n" if i else "") + para}
    if focus is not None:
        yield {"type": "tool_call", "name": "focus_event", "input": {"event_id": focus}}
        yield {"type": "tool_result", "name": "focus_event", "output": f'{{"focus": {focus}}}', "is_error": False}
    yield {"type": "done"}
