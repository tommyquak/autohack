"""Model inputs: allowed columns plus physics-informed and event-history features.

History features only look at an event's *earlier* CDMs (larger time_to_tca), never later ones.
"""

import numpy as np
import pandas as pd

from triage.data import EVENT, feature_matrix
from triage.tiers import RISK_CRITICAL, RISK_ELEVATED

SIGMA_SENTINEL_M = 1e7  # dataset uses 63,781,360 m (10 Earth radii) when covariance is unusable


def dilution_flag(df: pd.DataFrame) -> np.ndarray:
    """Covariance too large to trust: a low Pc here means 'unknown', not 'below threshold'."""
    return ((df["c_sigma_r"] > SIGMA_SENTINEL_M) | (df["t_sigma_r"] > SIGMA_SENTINEL_M)).to_numpy()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    X = feature_matrix(df)
    sig_c = df["c_sigma_r"].where(df["c_sigma_r"] < SIGMA_SENTINEL_M)
    sig_t = df["t_sigma_r"].where(df["t_sigma_r"] < SIGMA_SENTINEL_M)
    X["c_sigma_r"], X["t_sigma_r"] = sig_c, sig_t
    X["log_miss"] = np.log10(df["miss_distance"].clip(lower=1))
    X["log_sigma_c"] = np.log10(sig_c)
    X["log_sigma_t"] = np.log10(sig_t)
    # Miss distance in units of combined radial sigma (Mahalanobis-like, radial only)
    X["miss_over_sigma"] = df["miss_distance"] / np.sqrt(sig_c**2 + sig_t**2)
    rel = df[["relative_position_r", "relative_position_t", "relative_position_n"]].to_numpy()
    X["radial_share"] = np.abs(rel[:, 0]) / (np.linalg.norm(rel, axis=1) + 1e-9)
    X["margin_critical"] = df["max_risk_estimate"] - RISK_CRITICAL
    X["margin_elevated"] = df["max_risk_estimate"] - RISK_ELEVATED
    X["dilution"] = dilution_flag(df).astype(int)

    # Event history from earlier CDMs only (load_cdms sorts each event by time_to_tca descending)
    g = df.groupby(EVENT, sort=False)
    X["cdm_index"] = g.cumcount()
    X["d_max_risk"] = g["max_risk_estimate"].diff()
    X["d_log_miss"] = X["log_miss"].groupby(df[EVENT]).diff()
    X["max_risk_so_far"] = g["max_risk_estimate"].cummax()
    return X


# Physics-sense monotonic constraints: more upper-bound risk -> more risk, more distance -> less risk.
MONOTONIC = {"max_risk_estimate": 1, "margin_critical": 1, "margin_elevated": 1, "log_miss": -1, "miss_distance": -1}
