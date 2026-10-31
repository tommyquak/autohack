"""Event action queue (triage/actions.py): invariants that must hold for every event."""

import itertools
import json
from pathlib import Path

import pytest

from triage.actions import MANEUVER, MONITOR, QUEUES, REVIEW, action
from triage.explain import BANNED


def make_event(tier=0, misses=(20_000.0, 20_000.0, 20_000.0), pcs=(-9.0, -9.0, -9.0), cautions=(), days=3.0, **extra):
    history = [
        {"time_to_tca_days": days + 1.0 * (len(misses) - 1 - i), "miss_distance_m": m, "max_risk_estimate_log10": pc}
        for i, (m, pc) in enumerate(zip(misses, pcs, strict=True))
    ]
    return {
        "event_id": 1,
        "tier": tier,
        "baseline_tier": tier,
        "needs_review": "needs_review" in cautions,
        "cautions": list(cautions),
        "latest": {
            "time_to_tca_days": days,
            "miss_distance_m": misses[-1],
            "max_risk_estimate_log10": pcs[-1],
            "sigma_r_m": {"chaser": 50.0, "target": 5.0},
        },
        "history": history,
        **extra,
    }


CAUTION_SETS = [(), ("needs_review",), ("no_covariance",), ("pc_diluted",), ("needs_review", "no_covariance")]
TRENDS = [
    ((20_000.0, 20_000.0, 20_000.0), (-9.0, -9.0, -9.0)),  # far and flat
    ((9_000.0, 7_000.0, 5_600.0), (-7.5, -7.0, -6.5)),  # closing on 5 km
    ((2_500.0, 1_800.0, 1_200.0), (-6.0, -5.5, -5.0)),  # closing on 1 km
    ((600.0, 600.0, 600.0), (-3.0, -3.0, -3.0)),  # inside 1 km
]
FORECASTS = [None, {"p_final": [0.98, 0.01, 0.01]}, {"p_final": [0.1, 0.2, 0.7]}, {"prediction_set": ["Critical"]}]


def all_events():
    for tier, cautions, (misses, pcs), days, fc in itertools.product(
        (0, 1, 2), CAUTION_SETS, TRENDS, (0.3, 3.0), FORECASTS
    ):
        extra = {"forecast": fc} if fc else {}
        yield make_event(tier, misses, pcs, cautions, days, **extra)


def test_exactly_one_queue_per_event():
    for e in all_events():
        out = action(e)
        assert out["queue"] in QUEUES  # a single string: the queues are mutually exclusive by construction
        assert isinstance(out["escalation_watch"], bool)
        assert out["reasons"] and all(isinstance(r, str) and r for r in out["reasons"])


def test_critical_always_lands_in_maneuver_planning():
    for e in all_events():
        if e["tier"] == 2:
            out = action(e)
            assert out["queue"] == MANEUVER
            assert out["escalation_watch"] is False  # already at the top tier


def test_no_covariance_never_lands_in_monitor():
    for e in all_events():
        if "no_covariance" in e["cautions"]:
            assert action(e)["queue"] != MONITOR


def test_elevated_and_needs_review_go_to_analyst_review():
    assert action(make_event(tier=1))["queue"] == REVIEW
    assert action(make_event(tier=0, cautions=("needs_review",)))["queue"] == REVIEW
    assert action(make_event(tier=0, cautions=("pc_diluted",)))["queue"] == REVIEW


def test_never_says_safe():
    for e in all_events():
        out = action(e)
        assert not BANNED.search(" ".join(out["reasons"]) + out["queue"])


def test_closing_trend_near_a_threshold_raises_a_below_threshold_event():
    far = make_event(tier=0)
    assert action(far) == {"queue": MONITOR, "reasons": action(far)["reasons"], "escalation_watch": False}
    closing = make_event(tier=0, misses=(9_000.0, 7_000.0, 5_600.0), pcs=(-7.5, -7.0, -6.5))
    out = action(closing)
    assert out["escalation_watch"] and out["queue"] == REVIEW
    assert any("Closing" in r for r in out["reasons"])
    # Too close to TCA for the trend rule (policy): the current tier governs.
    assert not action(make_event(tier=0, misses=(9_000.0, 7_000.0, 5_600.0), days=0.3))["escalation_watch"]


def test_elevated_closing_on_1km_keeps_review_and_sets_the_watch():
    out = action(make_event(tier=1, misses=(2_500.0, 1_800.0, 1_200.0), pcs=(-6.0, -5.5, -5.0)))
    assert out["queue"] == REVIEW and out["escalation_watch"]


def test_labels_are_never_read():
    e = make_event(tier=0, misses=(9_000.0, 7_000.0, 5_600.0), pcs=(-7.5, -7.0, -6.5))
    labelled = json.loads(json.dumps(e))
    labelled["true_tier"] = 2
    for h in labelled["history"]:
        h["risk_log10"] = -2.0
    assert action(labelled) == action(e)


def test_forecast_hook_only_raises_the_queue():
    low = {"calibrated": True, "p_final": [0.98, 0.01, 0.01], "prediction_set": ["Below threshold"]}
    assert action(make_event(tier=2, misses=(600.0,) * 3, pcs=(-3.0,) * 3, forecast=low))["queue"] == MANEUVER
    assert action(make_event(tier=1, forecast=low))["queue"] == REVIEW
    cal = {"calibrated": True}
    assert action(make_event(tier=0, forecast={**cal, "p_final": [0.1, 0.2, 0.7]}))["queue"] == MANEUVER
    assert action(make_event(tier=0, forecast={**cal, "p_final": [0.7, 0.25, 0.05]}))["queue"] == REVIEW
    assert action(make_event(tier=0, forecast={**cal, "p_final": "bad"}))["queue"] == MONITOR  # malformed -> ignored


def test_forecast_hook_ignores_uncalibrated_scores():
    # The shipped final-tier forecast carries uncalibrated scores: it must never move a queue.
    assert action(make_event(tier=0, forecast={"p_final": [0.1, 0.2, 0.7]}))["queue"] == MONITOR
    shipped = {"calibrated": False, "p_final": [0.1, 0.2, 0.7], "predicted_final_tier": 2}
    assert action(make_event(tier=0, forecast=shipped))["queue"] == MONITOR


def test_build_events_attaches_actions(cdms):
    from triage.build_events import build

    out = build(cdms)
    assert all(set(e["action"]) == {"queue", "reasons", "escalation_watch"} for e in out["events"])
    assert sum(out["summary"]["by_action"].values()) == out["summary"]["n_events"]
    assert set(out["summary"]["by_action"]) == set(QUEUES)
    for e in out["events"]:
        if e["tier"] == 2:
            assert e["action"]["queue"] == MANEUVER


DEMO = Path(__file__).resolve().parent.parent / "data" / "demo" / "events.json"


@pytest.mark.skipif(not DEMO.exists(), reason="no frozen demo events")
def test_frozen_demo_events_respect_the_invariants():
    data = json.loads(DEMO.read_text())
    events = data["events"]
    assert sum(data["summary"]["by_action"].values()) == len(events)
    for e in events:
        q = e["action"]["queue"]
        assert q in QUEUES
        assert (q == MANEUVER) == (e["tier"] == 2)
        assert not ("no_covariance" in e["cautions"] and q == MONITOR)
        assert not BANNED.search(" ".join(e["action"]["reasons"]))
