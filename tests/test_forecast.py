"""Final-tier forecaster (official task). Synthetic data only, no API key, no raw data needed."""

import json
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
import pytest

from triage.forecast import (
    Forecaster,
    ForecastMismatch,
    attach,
    cache_key,
    choose_hybrid_thresholds,
    choose_thresholds,
    choose_two_lines,
    decide,
    decide_lines,
    decision_records,
    escalate,
    floor_reason,
    floor_tier,
    load_predictions,
    recall_cut,
    write_predictions,
)
from triage.forecast_features import (
    FORBIDDEN,
    LABELS_XLSX,
    cutoff_inputs,
    event_features,
    label_agreement,
    load_labels,
)
from triage.tiers import Tier

ROOT = Path(__file__).resolve().parent.parent
PREDICTIONS = ROOT / "predictions" / "test_final_tier.csv"
DEMO_EVENTS = ROOT / "data" / "demo" / "events.json"
TH = {"t_crit": 0.5, "t_elev": 0.4, "critical_recall_target": 0.9}


def test_no_message_under_two_days_reaches_the_features(cdms):
    inputs = cutoff_inputs(cdms)
    assert (inputs["time_to_tca"] >= 2.0).all()
    feats = event_features(inputs)
    assert (feats["tca_latest"] >= 2.0).all()
    # Changing every < 2-day message (values and risk) leaves the features unchanged.
    moved = cdms.copy()
    late = moved["time_to_tca"] < 2.0
    moved.loc[late, ["miss_distance", "max_risk_estimate", "risk", "c_sigma_r"]] = [1.0, 0.0, 0.0, 1.0]
    pd.testing.assert_frame_equal(feats, event_features(cutoff_inputs(moved)))
    with pytest.raises(ValueError, match="< 2 days"):
        event_features(cdms)


def test_no_risk_column_in_the_inputs(cdms):
    inputs = cutoff_inputs(cdms)
    assert not FORBIDDEN & set(inputs.columns)
    feats = event_features(inputs)
    assert not FORBIDDEN & set(feats.columns)
    shifted = cdms.assign(risk=cdms["risk"] - 7.0)  # the label moves, the features must not
    pd.testing.assert_frame_equal(feats, event_features(cutoff_inputs(shifted)))


def test_critical_floor_is_never_downgraded():
    rng = np.random.default_rng(0)
    p = rng.dirichlet([1, 1, 1], size=500)
    floor = rng.integers(0, 3, size=500)
    miss = rng.uniform(100, 20_000, size=500)
    for t_elev, t_crit in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0), (2.0, 2.0)]:
        for pred in (decide(floor, p, t_elev, t_crit), decide_lines(floor, miss, t_crit * 2e3, t_elev * 6e3)):
            assert (pred >= floor).all()
            assert (pred[floor == Tier.CRITICAL] == Tier.CRITICAL).all()
    # Even a model certain of "below threshold" cannot lower a rule-defined Critical.
    assert decide(np.array([2]), np.array([[1.0, 0.0, 0.0]]), 0.9, 0.9)[0] == Tier.CRITICAL
    assert (escalate(floor, np.zeros(500, bool), np.zeros(500, bool)) == floor).all()
    # The baseline lines: Critical at or under m_crit, else Elevated at or under m_elev, else the floor.
    got = decide_lines(np.zeros(4, int), np.array([1_100.0, 1_101.0, 5_400.0, 5_401.0]), 1_100.0, 5_400.0)
    assert got.tolist() == [2, 1, 1, 0]


def test_floor_rules(cdms):
    feats = event_features(cutoff_inputs(cdms))
    feats["nowcast_tier"] = 0  # a nowcast that demoted everything still cannot lower Critical or the miss tier
    floor = floor_tier(feats)
    assert (floor[feats["rule_tier"].to_numpy() == Tier.CRITICAL] == Tier.CRITICAL).all()
    assert (floor >= feats["miss_tier"].to_numpy()).all()
    assert (floor_tier(feats, "rule") == feats["rule_tier"].to_numpy()).all()


def test_thresholds_reach_the_recall_target_on_their_own_scores():
    rng = np.random.default_rng(1)
    y = rng.choice([0, 1, 2], size=400, p=[0.7, 0.2, 0.1])
    p = rng.dirichlet([1, 1, 1], size=400)
    floor = np.where(rng.random(400) < 0.5, y, 0)
    th = choose_thresholds(y, p, floor, target=0.95)
    pred = decide(floor, p, th["t_elev"], th["t_crit"])
    assert (pred[y == 2] == 2).mean() >= 0.95
    # the HIGHEST threshold that meets the target (fewest escalations): any higher threshold misses it
    stricter = decide(floor, p, th["t_elev"], np.nextafter(th["t_crit"], 1))
    assert (stricter[y == 2] == 2).mean() < 0.95
    miss = np.where(y == 2, rng.uniform(500, 3_000, 400), rng.uniform(1_000, 30_000, 400))
    lines = choose_two_lines(y, floor, miss, target=0.95)
    assert (decide_lines(floor, miss, lines["m_crit"], lines["m_elev"])[y == 2] == 2).mean() >= 0.95
    assert choose_hybrid_thresholds(y, p, floor, miss)["critical_recall_target"] == 0.9


def test_recall_cut_needs_no_escalation_when_the_floor_already_meets_the_target():
    y = np.array([2, 2, 0])
    assert recall_cut(np.array([0.1, 0.2, 0.9]), y, np.array([2, 2, 0]), 0.95) == float("inf")


def test_model_ignores_the_record_only_flag(cdms):
    feats = event_features(cutoff_inputs(cdms)).assign(
        nowcast_tier=lambda f: f["rule_tier"], nowcast_p_elevated=0.5, nowcast_untrusted=0
    )
    m = Forecaster().fit(pd.concat([feats] * 30), np.tile([0, 1, 2, 2], 30))
    assert "nowcast_untrusted" not in m.columns and not FORBIDDEN & set(m.columns)


def test_model_and_decision_records(cdms):
    feats = event_features(cutoff_inputs(cdms)).assign(nowcast_tier=lambda f: f["rule_tier"], nowcast_p_elevated=0.5)
    y = np.array([0, 1, 2, 2])
    m = Forecaster().fit(pd.concat([feats] * 30), np.tile(y, 30))
    p = m.predict_proba(feats)
    assert np.allclose(p.sum(1), 1) and (p >= 0).all()
    rec = decision_records(feats, p, TH)
    assert (rec["predicted_final_tier"] >= rec["floor_tier"]).all()
    text = " ".join(" ".join(r) for r in rec["reasons"]).lower()
    assert "safe" not in text and "manoeuv" not in text and "maneuv" not in text
    assert rec["reasons"].map(len).between(1, 3).all()


def _feats_one(miss, rule_tier, miss_tier_, pc_tier_, nowcast_tier, untrusted=0):
    row = {
        "tca_latest": 2.2,
        "miss_latest": miss,
        "log_miss_latest": np.log10(miss),
        "log_miss_change": 0.0,
        "log_miss_min": np.log10(miss),
        "n_cdm": 5,
        "mre_latest": -5.0,
        "mre_max": -5.0,
        "mre_slope": 0.0,
        "sigma_placeholder": 0,
        "log_sigma_c_latest": 1.0,
        "rule_tier": rule_tier,
        "miss_tier": miss_tier_,
        "pc_bound_tier": pc_tier_,
        "nowcast_tier": nowcast_tier,
        "nowcast_untrusted": untrusted,
    }
    return pd.DataFrame([row], index=pd.Index([7], name="event_id"))


def test_escalation_records_state_the_comparison_as_a_score():
    crit = decision_records(_feats_one(1_200.0, 1, 1, 0, 1), np.array([[0.1, 0.3, 0.6]]), TH).iloc[0]
    assert crit["decision"] == "escalated to Critical" and crit["escalation_rule"] == "model_score_critical"
    assert "0.60" in crit["reasons"][0] and "0.50" in crit["reasons"][0] and "not a probability" in crit["reasons"][0]
    elev = decision_records(_feats_one(8_000.0, 0, 0, 0, 0), np.array([[0.5, 0.45, 0.05]]), TH).iloc[0]
    assert elev["decision"] == "escalated to Elevated" and elev["escalation_rule"] == "model_score_elevated"
    assert "not a probability" in elev["reasons"][0]
    kept = decision_records(_feats_one(8_000.0, 0, 0, 0, 0), np.array([[0.9, 0.05, 0.05]]), TH).iloc[0]
    assert kept["decision"] == "floor kept" and kept["escalation_rule"] == ""


def test_floor_reason_names_an_untrusted_input():
    # Pc-only Elevated whose demotion was blocked by a missing input: say so, not "the demoter kept it".
    r = _feats_one(8_000.0, 1, 0, 1, 1, untrusted=1).iloc[0]
    assert "missing or invalid" in floor_reason(r, Tier.ELEVATED)
    r = _feats_one(8_000.0, 1, 0, 1, 1, untrusted=0).iloc[0]
    assert "constrained demoter kept it" in floor_reason(r, Tier.ELEVATED)


def test_attach_round_trip_and_refuses_a_stale_forecast(tmp_path, cdms):
    feats = event_features(cutoff_inputs(cdms)).assign(nowcast_tier=lambda f: f["rule_tier"], nowcast_p_elevated=0.5)
    rng = np.random.default_rng(2)
    rec = decision_records(feats, rng.dirichlet([1, 1, 1], size=len(feats)), TH)
    path = tmp_path / "pred.csv"
    write_predictions(rec, path)
    back = load_predictions(path)
    assert back["reasons"].tolist() == rec["reasons"].tolist()
    events = [{"event_id": int(i), "tier": int(back.loc[i, "floor_tier"]), "x": [1]} for i in back.index]
    data = {"summary": {"n": len(events)}, "events": events}
    out = attach(json.loads(json.dumps(data)), back)
    for e in out["events"]:
        fc = e["forecast"]
        assert fc["calibrated"] is False and "p_final" not in fc and "not a probability" in fc["score_note"]
        assert fc["predicted_final_tier"] >= fc["floor_tier"] == e["tier"]
        assert (fc["escalation"] is None) == (fc["decision"] == "floor kept")
        if fc["escalation"]:
            x = fc["escalation"]
            assert x["rule"] == "model_score" and x["value"] >= x["threshold"]
            assert x["to_tier"] == fc["predicted_final_tier"]
    stale = json.loads(json.dumps(data))
    stale["events"][0]["tier"] = (stale["events"][0]["tier"] + 1) % 3
    with pytest.raises(ForecastMismatch, match="stale"):
        attach(stale, back)
    with pytest.raises(ForecastMismatch, match="other ids"):
        attach({"summary": {}, "events": events[:-1]}, back)


def test_cache_key_changes_with_data_and_split():
    a = cache_key("cv0", "data1", [1, 2], [3])
    assert a == cache_key("cv0", "data1", [2, 1], [3])  # id order does not matter
    assert a != cache_key("cv0", "data2", [1, 2], [3])
    assert a != cache_key("cv0", "data1", [1, 3], [2])
    assert a.startswith("cv0_")


def _write_xlsx(path, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "train_event_labels"
    ws.append(["One row per train_data event (synthetic)"])
    ws.append([])
    ws.append(
        ["event_id", "mission_id", "final_risk_log10_pc", "final_miss_distance_m", "final_tier", "usable_for_training"]
    )
    for r in rows:
        ws.append(r)
    wb.save(path)


def test_labels_load_and_cross_check(tmp_path, cdms):
    path = tmp_path / "labels.xlsx"
    # Final CDMs of the synthetic fixture: events 1-4 are below threshold, Elevated, Critical, Critical.
    _write_xlsx(
        path,
        [[1, 7, -30, 20000, "Safe", "yes"], [2, 7, -5, 8000, "Elevated", "yes"], [3, 7, -3.5, 3000, "Critical", "yes"]]
        + [[4, 7, -9, 600, "Critical", "no"]],
    )
    labels = load_labels(path)
    assert labels["final_tier"].to_dict() == {1: 0, 2: 1, 3: 2, 4: 2}
    assert labels["usable"].tolist() == [True, True, True, False]
    agree = label_agreement(labels, cdms)
    assert agree["matched"] == 4 and agree["agree"] == 4


@pytest.mark.skipif(not LABELS_XLSX.exists(), reason="organisers' xlsx not in data/raw/labels")
def test_real_labels_load():
    labels = load_labels()
    assert len(labels) == 13_154 and labels["final_tier"].isin([0, 1, 2]).all()
    assert labels["usable"].sum() == 11_942


@pytest.mark.skipif(not PREDICTIONS.exists(), reason="no committed test predictions")
def test_predictions_file_has_one_row_per_test_event():
    pred = load_predictions(PREDICTIONS)
    assert pred.index.is_unique
    events = json.loads(DEMO_EVENTS.read_text())["events"]
    assert set(pred.index) == {e["event_id"] for e in events}
    assert (pred["predicted_final_tier"] >= pred["floor_tier"]).all()
    assert pred["reasons"].map(len).between(1, 3).all()


@pytest.mark.skipif(not DEMO_EVENTS.exists(), reason="no frozen demo events")
def test_demo_events_forecast_never_lowers_a_critical():
    events = json.loads(DEMO_EVENTS.read_text())["events"]
    for e in events:
        fc = e["forecast"]
        assert fc["predicted_final_tier"] >= fc["floor_tier"] == e["tier"]
        if e["tier"] == Tier.CRITICAL:
            assert fc["predicted_final_tier"] == Tier.CRITICAL
        assert 1 <= len(fc["reasons"]) <= 3 and fc["calibrated"] is False and "p_final" not in fc
