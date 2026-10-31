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


def build_features_v2(df: pd.DataFrame) -> pd.DataFrame:
    """v1 features (unchanged) plus richer geometry and earlier-CDM history features."""
    X = build_features(df)
    ev = df[EVENT]
    g = df.groupby(EVENT, sort=False)
    sig_c, sig_t = X["c_sigma_r"], X["t_sigma_r"]
    sig_comb = np.sqrt(sig_c**2 + sig_t**2)
    log_sig_comb = np.log10(sig_comb)
    X["log_sigma_comb"] = log_sig_comb
    X["log_rel_speed"] = np.log10(df["relative_speed"].clip(lower=1))
    # Radial miss in units of combined radial sigma, and a crude Gaussian Pc proxy (radial plane only)
    X["r_over_sigma"] = df["relative_position_r"].abs() / sig_comb
    X["pc_proxy"] = (-0.5 * np.log10(np.e) * X["miss_over_sigma"] ** 2 - 2 * log_sig_comb).clip(lower=-100)
    X["sigma_ratio"] = np.log10(sig_c / sig_t)
    rel = df[["relative_position_r", "relative_position_t", "relative_position_n"]].to_numpy()
    norm = np.linalg.norm(rel, axis=1) + 1e-9
    X["t_share"] = np.abs(rel[:, 1]) / norm
    X["n_share"] = np.abs(rel[:, 2]) / norm
    # Upper bound is achieved at the worst-case covariance scale; distance to it in sigma units
    X["risk_gap_proxy"] = df["max_risk_estimate"] - X["pc_proxy"]

    # ---- history: earlier CDMs only (cumulative / expanding ops on the time-descending order) ----
    first = g.transform("first")
    X["time_since_first"] = first["time_to_tca"] - df["time_to_tca"]
    X["d_time"] = -g["time_to_tca"].diff()
    X["max_risk_minus_first"] = df["max_risk_estimate"] - first["max_risk_estimate"]
    X["log_miss_minus_first"] = X["log_miss"] - np.log10(first["miss_distance"].clip(lower=1))
    X["min_log_miss_so_far"] = X["log_miss"].groupby(ev).cummin()
    X["min_risk_so_far"] = g["max_risk_estimate"].cummin()
    X["mean_risk_so_far"] = g["max_risk_estimate"].cumsum() / (X["cdm_index"] + 1)
    X["n_elevated_so_far"] = (df["max_risk_estimate"] >= RISK_ELEVATED).astype(int).groupby(ev).cumsum()
    X["frac_elevated_so_far"] = X["n_elevated_so_far"] / (X["cdm_index"] + 1)
    X["d_log_sigma_c"] = X["log_sigma_c"].groupby(ev).diff()
    X["d_log_sigma_t"] = X["log_sigma_t"].groupby(ev).diff()
    X["log_sigma_c_minus_first"] = X["log_sigma_c"] - X["log_sigma_c"].groupby(ev).transform("first")
    X["d_miss_over_sigma"] = X["miss_over_sigma"].groupby(ev).diff()
    X["d_pc_proxy"] = X["pc_proxy"].groupby(ev).diff()
    X["max_pc_proxy_so_far"] = X["pc_proxy"].groupby(ev).cummax()
    # Expanding OLS slope of max_risk_estimate vs time_to_tca (per day; NaN with < 2 CDMs)
    t, r = df["time_to_tca"], df["max_risk_estimate"]
    n = X["cdm_index"] + 1
    st, sr = t.groupby(ev).cumsum(), r.groupby(ev).cumsum()
    stt, str_ = (t * t).groupby(ev).cumsum(), (t * r).groupby(ev).cumsum()
    den = n * stt - st**2
    X["risk_slope"] = (-(n * str_ - st * sr) / den.where(den > 1e-9)).clip(-50, 50)
    lm = X["log_miss"]
    slm, stlm = lm.groupby(ev).cumsum(), (t * lm).groupby(ev).cumsum()
    X["log_miss_slope"] = (-(n * stlm - st * slm) / den.where(den > 1e-9)).clip(-50, 50)
    return X


# Physics-sense monotonic constraints: more upper-bound risk -> more risk, more distance -> less risk.
MONOTONIC = {"max_risk_estimate": 1, "margin_critical": 1, "margin_elevated": 1, "log_miss": -1, "miss_distance": -1}
