import numpy as np
import pytest

from triage import model
from triage.build_events import build
from triage.data import FEATURES, LABEL, feature_matrix, group_folds, latest_cdm
from triage.evaluate import evaluate
from triage.tiers import Tier, miss_tier, pc_tier, true_tier


@pytest.mark.parametrize(
    ("risk", "expected"),
    [(-6.0001, Tier.SAFE), (-6.0, Tier.ELEVATED), (-4.0001, Tier.ELEVATED), (-4.0, Tier.CRITICAL), (-30, Tier.SAFE)],
)
def test_pc_thresholds_are_exact(risk, expected):
    assert pc_tier(risk) == expected


@pytest.mark.parametrize(
    ("miss_m", "expected"),
    [(999.9, Tier.CRITICAL), (1000, Tier.ELEVATED), (5000, Tier.ELEVATED), (5000.1, Tier.SAFE)],
)
def test_miss_distance_thresholds_are_exact(miss_m, expected):
    assert miss_tier(miss_m) == expected


def test_worse_rule_wins():
    assert true_tier(-30, 500) == Tier.CRITICAL  # tiny Pc but < 1 km
    assert true_tier(-3, 50_000) == Tier.CRITICAL  # far but high Pc
    assert true_tier(-5, 50_000) == Tier.ELEVATED
    assert true_tier(-7, 50_000) == Tier.SAFE


def test_loader_keeps_only_allowed_columns(cdms):
    assert "mission_id" not in cdms.columns
    assert set(feature_matrix(cdms).columns) == set(FEATURES)
    assert LABEL not in feature_matrix(cdms).columns  # the label must never leak into features


def test_group_folds_never_split_an_event(cdms):
    for train_idx, val_idx in group_folds(cdms, n_splits=2):
        assert not set(cdms.loc[train_idx, "event_id"]) & set(cdms.loc[val_idx, "event_id"])


def test_latest_cdm_is_closest_to_tca(cdms):
    last = latest_cdm(cdms)
    assert len(last) == cdms["event_id"].nunique()
    assert np.allclose(last["time_to_tca"], 0.6)


def test_model_contract(cdms):
    out = model.predict(cdms)
    assert list(out.columns) == ["pred_tier", "confidence", "needs_review"]
    assert out.index.equals(cdms.index)
    assert out["pred_tier"].isin([0, 1, 2]).all() and out["confidence"].between(0, 1).all()


def test_evaluate_report_shape(cdms):
    report = evaluate(cdms, "fixture")
    assert {"majority_class", "miss_distance_rule", "max_risk_estimate_rule", "model"} <= set(report["results"])
    assert sum(report["class_counts"].values()) == len(cdms)
    assert report["results"]["model"]["confusion"] and report["by_lead_time"]["model"]


def test_events_contract(cdms):
    out = build(cdms)
    assert out["summary"]["n_events"] == 4 == len(out["events"])
    tiers = [e["tier"] for e in out["events"]]
    assert tiers == sorted(tiers, reverse=True)  # most urgent first
    e = out["events"][0]
    assert {"event_id", "tier", "tier_name", "reasons", "latest", "history", "needs_review"} <= set(e)
    assert len(e["latest"]["relative_position_rtn_m"]) == 3
    assert all(set(ev["cautions"]) <= {"needs_review", "no_covariance", "pc_diluted"} for ev in out["events"])
    assert set(out["summary"]["cautions"]) == {"needs_review", "no_covariance", "pc_diluted"}
    assert "Safe" not in {ev["tier_name"] for ev in out["events"]}  # we never say "safe"


def test_predict_file_keeps_row_order_and_needs_no_labels(cdm_csv, tmp_path):
    import pandas as pd

    from triage.predict import predict_file

    raw = pd.read_csv(cdm_csv).drop(columns=["risk"]).sample(frac=1, random_state=0)  # shuffled, unlabeled
    path = tmp_path / "live.csv"
    raw.to_csv(path, index=False)
    out = predict_file(path)
    assert list(out["row"]) == list(range(len(raw)))
    assert list(out["event_id"]) == list(raw["event_id"])
    assert (out["pred_tier"] <= out["baseline_tier"]).all()  # the model only ever demotes


def test_display_only_columns_never_reach_the_model(cdm_csv, tmp_path):
    import pandas as pd

    from triage.build_events import build
    from triage.data import DISPLAY_ONLY, feature_matrix, load_cdms
    from triage.features import build_features

    raw = pd.read_csv(cdm_csv)
    raw["geocentric_latitude"], raw["t_h_per"], raw["t_h_apo"] = 71.5, 690.0, 710.0
    path = tmp_path / "with_display.csv"
    raw.to_csv(path, index=False)
    df = load_cdms(path)
    assert set(DISPLAY_ONLY) <= set(df.columns)
    assert not set(DISPLAY_ONLY) & set(feature_matrix(df).columns)
    assert not set(DISPLAY_ONLY) & set(build_features(df).columns)
    out = build(df)
    assert out["events"][0]["latest"]["geocentric_latitude_deg"] == 71.5
    assert out["events"][0]["latest"]["target_altitude_km"] == [690.0, 710.0]
    assert sum(b["events"] for b in out["summary"]["by_latitude_band"]) == out["summary"]["n_events"]
    assert build(load_cdms(cdm_csv))["summary"]["by_latitude_band"] is None  # columns absent -> None
