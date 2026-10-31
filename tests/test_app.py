"""Fast checks that need no API key. Run: uv run pytest"""

import json
import os

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")  # client construction only; no requests are made

import pytest
from fastapi.testclient import TestClient

import tools
from agent import _tool_defs
from server import app
from triage.build_events import build


def test_tool_schemas_generated_from_signatures():
    schema = tools.TOOLS["http_get"].schema
    assert schema["input_schema"]["properties"] == {"url": {"type": "string"}}
    assert schema["input_schema"]["required"] == ["url"]
    assert schema["description"]


def test_tool_defs_enable_eager_streaming():
    client_tools = [t for t in _tool_defs() if "input_schema" in t]
    assert client_tools and all(t["eager_input_streaming"] for t in client_tools)


def test_validate_input():
    assert tools.validate_input("http_get", {"url": "https://example.com"}) is None
    assert "missing" in tools.validate_input("http_get", {})
    assert "should be string" in tools.validate_input("http_get", {"url": 3})
    assert "unexpected" in tools.validate_input("http_get", {"url": "x", "extra": 1})
    assert "Unknown tool" in tools.validate_input("nope", {})


async def test_side_effect_tools_blocked_without_approval(monkeypatch):
    monkeypatch.setattr(tools, "AUTO_APPROVE", False)
    ok, out = await tools.run_tool("send_notification", {"message": "hi"})
    assert not ok and "Blocked" in out


async def test_tool_exceptions_become_error_results():
    @tools.tool
    def _boom() -> str:
        """Always fails."""
        raise RuntimeError("kaboom")

    ok, out = await tools.run_tool("_boom", {})
    assert not ok and "kaboom" in out
    tools.TOOLS.pop("_boom")


def test_server_serves_pages_and_config():
    client = TestClient(app)
    assert "<title>" in client.get("/").text  # dashboard, or placeholder until it exists
    assert "<title>" in client.get("/chat").text
    assert client.get("/config").json()["model"]


@pytest.fixture
def api(tmp_path, monkeypatch, cdms):
    """Client whose reports/ is a temp dir holding events.json built from the synthetic fixture."""
    import server

    (tmp_path / "events.json").write_text(json.dumps(build(cdms)))
    monkeypatch.setattr(server, "REPORTS", tmp_path)
    return TestClient(server.app), tmp_path


def test_api_summary_and_events(api):
    client, _ = api
    summary = client.get("/api/summary").json()
    listing = client.get("/api/events").json()
    assert listing["total"] == summary["n_events"] == len(listing["events"])
    first = listing["events"][0]
    assert "history" not in first and first["n_updates"] >= 1
    tiers = [e["tier"] for e in listing["events"]]
    assert tiers == sorted(tiers, reverse=True)  # most urgent first

    crit = client.get("/api/events", params={"tier": 2}).json()
    assert crit["total"] == summary["by_tier"]["Critical"]
    assert all(e["tier"] == 2 for e in crit["events"])
    review = client.get("/api/events", params={"needs_review": True}).json()
    assert review["total"] == summary["needs_review"]


def test_api_event_detail(api):
    client, _ = api
    first = client.get("/api/events").json()["events"][0]
    detail = client.get(f"/api/events/{first['event_id']}").json()
    assert len(detail["history"]) == first["n_updates"]
    assert client.get("/api/events/999999").status_code == 404


def test_api_reloads_rebuilt_report_and_reports_missing_files(api):
    client, reports = api
    assert client.get("/api/metrics").status_code == 503  # not built yet
    path = reports / "events.json"
    path.write_text(json.dumps({"summary": {"n_events": 0}, "events": []}))
    os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 5))
    assert client.get("/api/summary").json() == {"n_events": 0}
    (reports / "metrics.json").write_text(json.dumps({"split": "test"}))
    assert client.get("/api/metrics").json()["split"] == "test"
