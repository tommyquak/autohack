"""Fast checks that need no API key. Run: uv run pytest"""

import os

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")  # client construction only; no requests are made

from fastapi.testclient import TestClient

import tools
from agent import _tool_defs
from server import app


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


def test_server_serves_ui_and_config():
    client = TestClient(app)
    assert "<title>" in client.get("/").text
    assert client.get("/config").json()["model"]
