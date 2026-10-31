"""Regression tests for the fixes found by evals/robustness_eval.py (junk and edge-case input)."""

import numpy as np
import pandas as pd
import pytest

from triage import model
from triage.data import load_cdms
from triage.features import build_features
from triage.predict import predict_file
from triage.tiers import Tier

ELEVATED_CANDIDATE = 2  # conftest event 2: Pc upper bound in [1e-6, 1e-4), miss > 5 km -> the model may demote it


class DemoteEverything:
    """Stand-in classifier scoring every candidate 0, so anything not protected gets demoted."""

    def predict_proba(self, X):
        return np.column_stack([np.ones(len(X)), np.zeros(len(X))])


def demote_all(df):
    return {"model": DemoteEverything(), "columns": list(build_features(df).columns), "threshold": 0.5}


def write(df, tmp_path, name="junk.csv"):
    path = tmp_path / name
    df.to_csv(path, index=False)
    return path


@pytest.mark.parametrize("col", ["miss_distance", "max_risk_estimate"])
def test_nan_rule_input_escalates_never_below_threshold(cdm_csv, tmp_path, col):
    raw = pd.read_csv(cdm_csv)
    raw.loc[raw["event_id"] == 1, col] = np.nan  # event 1 is otherwise far below threshold
    out = predict_file(write(raw, tmp_path))
    hit = out[raw[col].isna().to_numpy()]
    assert (hit["pred_tier"] >= Tier.ELEVATED).all() and hit["needs_review"].all()
    assert (hit["baseline_tier"] >= Tier.ELEVATED).all()


@pytest.mark.parametrize(
    ("col", "value"), [("miss_distance", np.nan), ("c_sigma_r", np.nan), ("c_object_type", "ALIEN SHIP")]
)
def test_untrusted_rows_are_never_demoted(cdm_csv, tmp_path, col, value):
    clean = load_cdms(cdm_csv)
    rows = clean["event_id"] == ELEVATED_CANDIDATE
    assert (model.predict(clean, demote_all(clean)).loc[rows, "pred_tier"] == Tier.SAFE).all()  # stub demotes

    raw = pd.read_csv(cdm_csv)
    raw[col] = raw[col].astype(object)
    raw.loc[raw["event_id"] == ELEVATED_CANDIDATE, col] = value
    df = load_cdms(write(raw, tmp_path))  # unknown object type -> missing category, like any live file
    out = model.predict(df, demote_all(df))
    assert (out.loc[rows, "pred_tier"] >= Tier.ELEVATED).all()
    assert out.loc[rows, "needs_review"].all()


def test_baseline_flags_placeholder_sigma_for_review(cdms):
    df = cdms.copy()
    rows = df["event_id"] == ELEVATED_CANDIDATE
    df.loc[rows, "c_sigma_r"] = 63_781_360.0
    out = model.predict(df, {})  # {} -> baseline rules, no trained artifact
    assert out.loc[rows, "needs_review"].all()


def test_empty_file_rejected_clearly(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text("")
    with pytest.raises(ValueError, match="empty"):
        predict_file(path)


def test_non_numeric_value_rejected_with_column_name(cdm_csv, tmp_path):
    raw = pd.read_csv(cdm_csv)
    raw["miss_distance"] = raw["miss_distance"].astype(object)
    raw.loc[3, "miss_distance"] = "far away"
    with pytest.raises(ValueError, match="'miss_distance'.*'far away'"):
        predict_file(write(raw, tmp_path))


def test_blank_event_id_rejected(cdm_csv, tmp_path):
    raw = pd.read_csv(cdm_csv)
    raw["event_id"] = raw["event_id"].astype(float)
    raw.loc[0, "event_id"] = np.nan
    with pytest.raises(ValueError, match="event_id"):
        predict_file(write(raw, tmp_path))
