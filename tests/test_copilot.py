"""Operator copilot: triage tools, local fallback router, /health and the /chat source switch. No API calls."""

import json
import os

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")  # client construction only; no requests are made

import pytest
from fastapi.testclient import TestClient

import agent
import fallback
import server
import tools
from triage import explain, reports
from triage.build_events import build

METRICS = {
    "split": "test",
    "class_counts": {"SAFE": 10, "ELEVATED": 5, "CRITICAL": 3},
    "results": {
        name: {
            "n": 18,
            "critical_recall": recall,
            "critical_precision": 0.75,
            "false_alarm_rate": 0.0667,
            "macro_f1": 0.8,
            "flagged_rate": 0.5,
            "under_tier_rate": 0.0,
            "confusion": [[9, 1, 0], [0, 4, 1], [0, 0, 3]],
        }
        for name, recall in (("model", 1.0), ("max_risk_estimate_rule", 1.0), ("miss_distance_rule", 0.6667))
    },
    "by_lead_time": {"model": []},
    "missed_criticals": [],
}
PROMPTS = [
    "give me a summary",
    "how many events are there?",
    "which events are safe?",
    "list critical events",
    "critical debris within 3 days",
    "what needs review?",
    "anything in the next 24 hours?",
    "elevated payload",
    "what is the recall and false alarm rate?",
    "tell me about event {eid}",
    "#{eid}",
    "compare {eid} and {other} and 999999",
    "event 999999",
    "should we manoeuvre?",
    "what's the weather",
]


@pytest.fixture
def report(tmp_path, monkeypatch, cdms):
    """Point triage.reports at a temp dir holding events.json (synthetic fixture) and a small metrics.json."""
    data = build(cdms)
    (tmp_path / "events.json").write_text(json.dumps(data))
    (tmp_path / "metrics.json").write_text(json.dumps(METRICS))
    monkeypatch.setattr(reports, "REPORTS", tmp_path)
    monkeypatch.setattr(reports, "DEMO", tmp_path / "no-demo")
    return data


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(explain, "_has_credentials", lambda: False)


def _stream(client, message):
    r = client.post("/chat", json={"message": message})
    assert r.status_code == 200
    return [json.loads(line) for line in r.text.splitlines() if line]


# ---------- tools ----------


def test_copilot_tools_registered_and_starter_tools_gone():
    names = set(tools.TOOLS)
    want = {"get_summary", "list_events", "get_event", "get_metrics", "explain_event", "compare_events", "focus_event"}
    assert want <= names
    assert not names & {"http_get", "send_notification"}
    assert want <= {t["name"] for t in agent._tool_defs() if "name" in t}


def test_summary_and_list_match_events_json(report):
    summary = tools.get_summary()
    assert summary["n_events"] == len(report["events"])
    assert summary["by_tier"] == report["summary"]["by_tier"]
    assert summary["report_source"] == "reports"
    assert summary["data_notes"]["earliest_latest_cdm_days_to_tca"] == round(
        min(e["latest"]["time_to_tca_days"] for e in report["events"]), 2
    )

    crit = tools.list_events(tier=2, limit=50)
    assert crit["total_matching"] == summary["by_tier"]["Critical"] == len(crit["events"])
    review = tools.list_events(needs_review=True)
    assert review["total_matching"] == summary["needs_review"]

    by_id = {e["event_id"]: e for e in report["events"]}
    rows = tools.list_events(limit=50)["events"]
    assert [r["event_id"] for r in rows] == [e["event_id"] for e in report["events"]]  # urgency order kept
    for row in rows:
        e = by_id[row["event_id"]]
        assert row["tier_name"] == e["tier_name"]
        assert row["miss_distance_m"] == round(e["latest"]["miss_distance_m"])
        assert row["pc_upper_log10"] == round(e["latest"]["max_risk_estimate_log10"], 2)
        assert set(row) >= {"baseline_tier", "time_to_tca_days", "needs_review", "cautions", "reasons"}


def test_list_filters_and_missing_window_note(report):
    soon = min(e["latest"]["time_to_tca_days"] for e in report["events"])
    assert tools.list_events(max_days_to_tca=soon)["total_matching"] >= 1
    empty = tools.list_events(max_days_to_tca=soon / 2)
    assert empty["total_matching"] == 0 and "no CDM closer than" in empty["note"]
    debris = tools.list_events(object_type="debris", limit=50)
    assert debris["total_matching"] == sum(e["latest"]["object_type"] == "DEBRIS" for e in report["events"])
    assert tools.list_events(limit=1000)["returned"] <= tools.MAX_LIST


def test_event_tools(report):
    e = report["events"][0]
    detail = tools.get_event(e["event_id"])
    assert detail["n_updates"] == len(e["history"]) == len(detail["history"])
    assert "true_tier" not in detail  # labels stay in the evaluation view
    assert e["tier_name"] in tools.explain_event(e["event_id"])["text"]

    other = report["events"][1]["event_id"]
    cmp = tools.compare_events([e["event_id"], other, 999999])
    assert [r["event_id"] for r in cmp["events"]] == [e["event_id"], other] and cmp["not_found"] == [999999]

    assert tools.focus_event(e["event_id"]) == {"focus": e["event_id"]}
    with pytest.raises(ValueError):
        tools.focus_event(999999)


async def test_unknown_event_is_an_error_result(report):
    ok, out = await tools.run_tool("get_event", {"event_id": 999999})
    assert not ok and "999999" in out


def test_metrics_tool_never_echoes_raw_labels(report):
    m = tools.get_metrics()
    assert m["scores"]["critical_recall"] == 1.0
    assert m["class_counts"] == {"Below threshold": 10, "Elevated": 5, "Critical": 3}
    assert not explain.BANNED.search(json.dumps(m))
    with pytest.raises(ValueError):
        tools.get_metrics("nope")


# ---------- local fallback ----------


def test_fallback_counts_match_summary(report):
    s = report["summary"]
    text, focus = fallback.answer("summary")
    assert focus is None
    assert f"{s['n_events']:,} events" in text
    for name, n in s["by_tier"].items():
        assert f"{n:,} {name}".lower() in text.lower()
    text, focus = fallback.answer("how many critical events?")
    assert text.startswith(f"{s['by_tier']['Critical']:,} events match (Critical)")
    text, _ = fallback.answer("what needs review?")
    assert text.startswith(f"{s['needs_review']:,} events match")


def test_fallback_event_and_focus(report):
    e = report["events"][0]
    text, focus = fallback.answer(f"tell me about event {e['event_id']}")
    assert focus == e["event_id"] and text == tools.explain_event(e["event_id"])["text"]
    assert fallback.answer("event 999999") == ("Event 999999 is not in the current report.", None)
    _, focus = fallback.answer("list critical events")
    assert focus == tools.list_events(tier=2)["events"][0]["event_id"]


def test_fallback_says_when_window_has_no_data(report):
    soon = min(e["latest"]["time_to_tca_days"] for e in report["events"])
    hours = max(1, int(soon * 24 / 2))
    text, focus = fallback.answer(f"anything within {hours} hours?")
    assert text.startswith("0 events match") and "no CDM closer than" in text and focus is None


def test_fallback_never_says_safe_or_recommends(report):
    ids = [e["event_id"] for e in report["events"]]
    for prompt in PROMPTS:
        text, _ = fallback.answer(prompt.format(eid=ids[0], other=ids[1]))
        assert text and not explain.BANNED.search(text), prompt
        assert "recommend" not in text.lower(), prompt
    assert "I'm answering in local mode" in fallback.answer("what's the weather")[0]


# ---------- server ----------


def test_health_shape(report, offline):
    h = TestClient(server.app).get("/health").json()
    assert set(h) == {"llm", "reports", "model", "last_answer"}
    assert h["llm"] == "fallback" and h["reports"] == "reports" and h["model"] == agent.MODEL


def test_health_reports_demo_copy(tmp_path, monkeypatch):
    demo = tmp_path / "demo"
    demo.mkdir()
    (demo / "events.json").write_text(json.dumps({"summary": {}, "events": []}))
    monkeypatch.setattr(reports, "REPORTS", tmp_path / "empty")
    monkeypatch.setattr(reports, "DEMO", demo)
    monkeypatch.setattr(explain, "_has_credentials", lambda: True)
    assert TestClient(server.app).get("/health").json() | {"model": None} == {
        "llm": "claude",
        "reports": "demo",
        "model": None,
        "last_answer": server.LAST_SOURCE,
    }


def test_chat_without_credentials_streams_fallback(report, offline):
    client = TestClient(server.app)
    e = report["events"][0]
    events = _stream(client, f"event {e['event_id']}")
    types = [x["type"] for x in events]
    assert types[0] == "session" and events[1] == {
        "type": "source",
        "source": "fallback",
        "reason": "no API credentials configured",
    }
    assert {"type": "tool_call", "name": "focus_event", "input": {"event_id": e["event_id"]}} in events
    assert types[-1] == "done"
    text = "".join(x["text"] for x in events if x["type"] == "text")
    assert text == tools.explain_event(e["event_id"])["text"]
    assert client.get("/health").json()["last_answer"] == "fallback"


async def _failing_agent(messages):
    yield {"type": "error", "text": "API error 529: overloaded"}
    yield {"type": "done"}


async def _working_agent(messages):
    yield {"type": "text", "text": "Event 1 is Critical."}
    yield {"type": "done"}


def test_chat_falls_back_when_claude_fails_before_text(report, monkeypatch):
    monkeypatch.setattr(explain, "_has_credentials", lambda: True)
    monkeypatch.setattr(server, "run_agent", _failing_agent)
    events = _stream(TestClient(server.app), "summary")
    sources = [x for x in events if x["type"] == "source"]
    assert sources == [{"type": "source", "source": "fallback", "reason": "API error 529: overloaded"}]
    text = "".join(x["text"] for x in events if x["type"] == "text")
    assert f"{report['summary']['n_events']:,} events" in text
    assert [x["type"] for x in events].count("done") == 1 and events[-1]["type"] == "done"


def test_chat_uses_claude_when_it_answers(report, monkeypatch):
    monkeypatch.setattr(explain, "_has_credentials", lambda: True)
    monkeypatch.setattr(server, "run_agent", _working_agent)
    events = _stream(TestClient(server.app), "summary")
    assert events[1] == {"type": "source", "source": "claude"}
    assert [x["type"] for x in events[2:]] == ["text", "done"]


def test_system_prompt_wording_rules():
    p = agent.SYSTEM_PROMPT.lower()
    assert "below threshold" in p and "focus_event" in p and "manoeuvre" in p
