"""Load CDM data, keep only the columns the challenge allows, split by event."""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from triage.tiers import true_tier

# Columns the challenge allows as model inputs (PDF, Challenge #1).
FEATURES = [
    "time_to_tca",
    "miss_distance",
    "relative_speed",
    "relative_position_r",
    "relative_position_t",
    "relative_position_n",
    "c_object_type",
    "c_sigma_r",
    "t_sigma_r",
    "max_risk_estimate",
    "F10",
    "AP",
]
# Display-only context (NOT allowed as model inputs): where and how high the conjunction happens.
# Kept for the dashboard; feature_matrix() only ever reads FEATURES, so these never reach the model.
DISPLAY_ONLY = ["geocentric_latitude", "t_h_per", "t_h_apo"]
EVENT = "event_id"
LABEL = "risk"  # log10(Pc) - target only, never a feature
CATEGORICAL = ["c_object_type"]
# Fixed category order so codes match between train, test and live data.
CATEGORIES = {"c_object_type": ["DEBRIS", "PAYLOAD", "ROCKET BODY", "TBA", "UNKNOWN"]}

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
SAMPLE_PATH = ROOT / "data" / "sample" / "cdm_sample.csv"


def find_csv(kind: str, data_dir: Path = RAW_DIR) -> Path:
    """Find the train or test CSV under data_dir (names vary between downloads)."""
    hits = sorted(p for p in Path(data_dir).rglob("*.csv") if kind in p.name.lower())
    if not hits:
        raise FileNotFoundError(f"No '*{kind}*.csv' under {data_dir}. See data/README.md for where to put the dataset.")
    return hits[0]


def read_cdm_csv(path: Path | str) -> pd.DataFrame:
    """Read and validate a CDM CSV: event_id, the allowed features and (if present) the label, in file order.

    Bad input is rejected with a ValueError that says what is wrong; missing *values* are kept (NaN) so the
    model can escalate those rows for review instead of tiering them (see triage.model.input_flags).
    """
    try:
        df = pd.read_csv(path)
    except pd.errors.EmptyDataError:
        raise ValueError(f"{path} is empty - expected a CSV header with columns {[EVENT, *FEATURES]}") from None
    return validate_cdms(df, str(path))


def validate_cdms(df: pd.DataFrame, source: str) -> pd.DataFrame:
    """The checks behind read_cdm_csv, for a frame already in memory (e.g. JSON rows sent to POST /api/triage).

    `source` names the input in error messages. Same output as read_cdm_csv: only event_id, the allowed features,
    the label and display-only columns are kept; numeric columns coerced; infinite feature values and unseen object
    types become missing.
    """
    missing = [c for c in [EVENT, *FEATURES] if c not in df.columns]
    if missing:
        raise ValueError(f"{source} is missing expected columns: {missing}")
    keep = [EVENT, *FEATURES] + ([LABEL] if LABEL in df.columns else [])
    keep += [c for c in DISPLAY_ONLY if c in df.columns]
    df = df[keep].copy()
    if df[EVENT].isna().any():
        raise ValueError(f"{source}: event_id is blank in {int(df[EVENT].isna().sum())} rows")
    for col in [c for c in keep if c not in CATEGORICAL]:
        num = pd.to_numeric(df[col], errors="coerce")
        bad = num.isna() & df[col].notna()
        if bad.any():
            i = bad.idxmax()
            raise ValueError(f"{source}: column {col!r} has non-numeric values, e.g. {df[col][i]!r} in data row {i}")
        if col in FEATURES:  # 'inf' / -inf is not a measurement: treat it as missing (escalated and flagged)
            num = num.where(np.isfinite(num))
        df[col] = num
    for col in CATEGORICAL:
        known = df[col].where(df[col].isin(CATEGORIES[col]))  # unseen labels -> missing (flagged by the model)
        df[col] = pd.Categorical(known, categories=CATEGORIES[col])
    return df


def load_cdms(path: Path | str) -> pd.DataFrame:
    """Read a CDM CSV keeping event_id, the allowed features and (if present) the label + true tier."""
    df = read_cdm_csv(path)
    if LABEL in df.columns:
        df["true_tier"] = true_tier(df[LABEL], df["miss_distance"])
    return df.sort_values([EVENT, "time_to_tca"], ascending=[True, False]).reset_index(drop=True)


def latest_cdm(df: pd.DataFrame) -> pd.DataFrame:
    """One row per event: the most recent CDM (smallest time_to_tca)."""
    return df.loc[df.groupby(EVENT)["time_to_tca"].idxmin()].reset_index(drop=True)


def group_folds(df: pd.DataFrame, n_splits: int = 5):
    """GroupKFold over event_id: CDMs of one event never straddle train and validation."""
    return GroupKFold(n_splits=n_splits).split(df, groups=df[EVENT])


def feature_matrix(df: pd.DataFrame) -> pd.DataFrame:
    X = df[FEATURES].copy()
    for col in CATEGORICAL:
        X[col] = X[col].cat.codes.replace(-1, np.nan)
    return X
