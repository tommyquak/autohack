"""Explain layer: template fallback, dilution flag, wording guardrail. Never calls the Claude API."""

import json
import os

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")  # client construction only; no requests are made

import pytest
from fastapi.testclient import TestClient

from triage import explain
from triage.build_events import build


@pytest.fixture
def events(cdms):
    return build(cdms)["events"]


def _event(tier_name="Critical", miss=600.0, pc=-3.2, sigma=(48.0, 5.1), needs_review=False):
    return {
        "event_id": 7,
        "tier": 2,
        "tier_name": tier_name,
        "confidence": 0.8,
        "needs_review": needs_review,
        "reasons": ["miss distance 600 m < 1 km"],
        "latest": {
            "time_to_tca_days": 2.0,
            "miss_distance_m": miss,
            "relative_speed_ms": 12_000.0,
            "relative_position_rtn_m": [1.0, 2.0, 3.0],
            "sigma_r_m": {"chaser": sigma[0], "target": sigma[1]},
            "max_risk_estimate_log10": pc,
            "object_type": "DEBRIS",
        },
        "history": [
            {"time_to_tca_days": 5.0, "miss_distance_m": 900.0, "max_risk_estimate_log10": -4.1, "pred_tier": 2},
            {"time_to_tca_days": 2.0, "miss_distance_m": miss, "max_risk_estimate_log10": pc, "pred_tier": 2},
        ],
    }


async def test_template_covers_every_built_event(events):
    for e in events:
        out = await explain.explain(e, use_llm=False)
        assert out["source"] == "template"
        assert e["tier_name"] in out["text"]
        assert not explain.BANNED.search(out["text"])


def test_dilution_flagged_when_uncertainty_swamps_miss_distance():
    assert explain.facts(_event(miss=600.0, pc=-5.0, sigma=(5_000.0, 10.0)))["diluted"]
    assert not explain.facts(_event(miss=600.0, pc=-5.0, sigma=(48.0, 5.1)))["diluted"]
    assert not explain.facts(_event(miss=600.0, pc=-3.0, sigma=(5_000.0, 10.0)))["diluted"]  # already critical by Pc


def test_capped_sigma_is_missing_uncertainty_not_dilution():
    f = explain.facts(_event(miss=600.0, pc=-5.0, sigma=(63_781_361.0, 10.0)))
    assert f["no_covariance"] and not f["diluted"] and f["combined_sigma_r"] is None
    assert any("no usable position uncertainty" in c for c in f["cautions"])


def test_template_mentions_review_and_trend():
    text = explain.template_explanation(explain.facts(_event(needs_review=True)))
    assert "Needs review" in text
    assert "900 m -> 600 m (closing)" in text


async def test_falls_back_to_template_when_claude_unavailable(monkeypatch):
    async def no_text(_facts):
        return None

    monkeypatch.setattr(explain, "_has_credentials", lambda: True)
    monkeypatch.setattr(explain, "_claude", no_text)
    assert (await explain.explain(_event()))["source"] == "template"


def test_guardrail_rejects_safe_wording():
    assert explain.BANNED.search("This event is safe.")
    assert explain.BANNED.search("Safety margin is fine")
    assert not explain.BANNED.search("Below threshold.")


def test_api_explain_route(tmp_path, monkeypatch, events):
    import server

    (tmp_path / "events.json").write_text(json.dumps({"summary": {}, "events": events}))
    monkeypatch.setattr(server, "REPORTS", tmp_path)
    monkeypatch.setattr(server, "DEMO", tmp_path / "no-demo")
    client = TestClient(server.app)

    r = client.get(f"/api/explain/{events[0]['event_id']}?llm=false")
    assert r.status_code == 200 and r.json()["source"] == "template"
    assert client.get("/api/explain/999999").status_code == 404
