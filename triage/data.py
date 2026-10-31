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
EVENT = "event_id"
LABEL = "risk"  # log10(Pc) - target only, never a feature
CATEGORICAL = ["c_object_type"]

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
SAMPLE_PATH = ROOT / "data" / "sample" / "cdm_sample.csv"


def find_csv(kind: str, data_dir: Path = RAW_DIR) -> Path:
    """Find the train or test CSV under data_dir (names vary between downloads)."""
    hits = sorted(p for p in Path(data_dir).rglob("*.csv") if kind in p.name.lower())
    if not hits:
        raise FileNotFoundError(f"No '*{kind}*.csv' under {data_dir}. See data/README.md for where to put the dataset.")
    return hits[0]


def load_cdms(path: Path | str) -> pd.DataFrame:
    """Read a CDM CSV keeping event_id, the allowed features and (if present) the label + true tier."""
    df = pd.read_csv(path)
    missing = [c for c in [EVENT, *FEATURES] if c not in df.columns]
    if missing:
        raise ValueError(f"{path} is missing expected columns: {missing}")
    keep = [EVENT, *FEATURES] + ([LABEL] if LABEL in df.columns else [])
    df = df[keep].copy()
    for col in CATEGORICAL:
        df[col] = df[col].astype("category")
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
