"""Final-tier forecaster (official task). Synthetic data only, no API key, no raw data needed."""

import json
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
import pytest

from triage.forecast import Forecaster, choose_thresholds, decide, decision_records, floor_tier
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
    for t_elev, t_crit in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0), (2.0, 2.0)]:
        pred = decide(floor, p, t_elev, t_crit)
        assert (pred >= floor).all()
        assert (pred[floor == Tier.CRITICAL] == Tier.CRITICAL).all()
    # Even a model certain of "below threshold" cannot lower a rule-defined Critical.
    assert decide(np.array([2]), np.array([[1.0, 0.0, 0.0]]), 0.9, 0.9)[0] == Tier.CRITICAL


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


def test_model_and_decision_records(cdms):
    feats = event_features(cutoff_inputs(cdms)).assign(nowcast_tier=lambda f: f["rule_tier"], nowcast_p_elevated=0.5)
    y = np.array([0, 1, 2, 2])
    m = Forecaster().fit(pd.concat([feats] * 30), np.tile(y, 30))
    p = m.predict_proba(feats)
    assert np.allclose(p.sum(1), 1) and (p >= 0).all()
    rec = decision_records(feats, p, {"t_elev": 0.5, "t_crit": 0.5})
    assert (rec["predicted_final_tier"] >= rec["floor_tier"]).all()
    text = " ".join(" ".join(r) for r in rec["reasons"]).lower()
    assert "safe" not in text and "manoeuv" not in text and "maneuv" not in text
    assert rec["reasons"].map(len).between(1, 3).all()


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
    pred = pd.read_csv(PREDICTIONS)
    assert pred["event_id"].is_unique
    n_test_events = len(json.loads(DEMO_EVENTS.read_text())["events"])
    assert len(pred) == n_test_events
    assert set(pred["event_id"]) == {e["event_id"] for e in json.loads(DEMO_EVENTS.read_text())["events"]}
    assert (pred["predicted_final_tier"] >= pred["floor_tier"]).all()
    assert np.allclose(pred[["p_below_threshold", "p_elevated", "p_critical"]].sum(axis=1), 1, atol=1e-3)


@pytest.mark.skipif(not DEMO_EVENTS.exists(), reason="no frozen demo events")
def test_demo_events_forecast_never_lowers_a_critical():
    events = json.loads(DEMO_EVENTS.read_text())["events"]
    for e in events:
        fc = e["forecast"]
        assert fc["predicted_final_tier"] >= fc["floor_tier"]
        if e["tier"] == Tier.CRITICAL:
            assert fc["floor_tier"] == fc["predicted_final_tier"] == Tier.CRITICAL
        assert 1 <= len(fc["reasons"]) <= 3
