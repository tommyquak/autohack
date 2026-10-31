"""Tier prediction behind a stable contract (see docs/CONTRACT.md).

    predict(df) -> DataFrame indexed like df with columns
        pred_tier    int  (0 below threshold, 1 Elevated, 2 Critical)
        confidence   float in [0, 1]
        needs_review bool (uncertain -> escalated, never down-graded)

    predict_detailed(df)          -> the same plus p_elevated (the model's score; NaN where it does not act)
    predict_with_certificates(df) -> predict() plus `certificate` (triage/certify.py: why the tier holds)

Uses the trained artifact (reports/model.joblib, from `python -m triage.train`) when present,
otherwise the conservative upper-bound baseline. Either way the deterministic rules hold:
Critical from the upper bound or miss < 1 km can never be removed by the model.
Rows with missing or unknown inputs (input_flags) are never demoted and always flagged for review;
a missing Pc upper bound or miss distance is never below Elevated.
"""

from functools import cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from triage.features import build_features, dilution_flag
from triage.tiers import RISK_CRITICAL, RISK_ELEVATED, Tier, miss_tier, pc_tier

ARTIFACT = Path(__file__).resolve().parent.parent / "reports" / "model.joblib"
REVIEW_MARGIN = 0.5  # baseline only: within half a decade of a Pc threshold -> needs review


@cache
def load_artifact(path: Path = ARTIFACT):
    return joblib.load(path) if path.exists() else None


def input_flags(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(missing_rule_input, untrusted): NaN Pc upper bound / miss distance; plus NaN sigma or unknown object type."""
    missing = df[["max_risk_estimate", "miss_distance"]].isna().any(axis=1).to_numpy()
    untrusted = missing | df[["c_sigma_r", "t_sigma_r"]].isna().any(axis=1).to_numpy() | df["c_object_type"].isna()
    return missing, np.asarray(untrusted)


def predict_baseline(df: pd.DataFrame) -> pd.DataFrame:
    upper = df["max_risk_estimate"].to_numpy(dtype=float)
    tier = np.maximum(pc_tier(upper), miss_tier(df["miss_distance"]))
    near = np.minimum(np.abs(upper - RISK_CRITICAL), np.abs(upper - RISK_ELEVATED)) < REVIEW_MARGIN
    review = (near | dilution_flag(df)) & (tier < Tier.CRITICAL)  # same dilution rule as the trained path
    return pd.DataFrame(
        {"pred_tier": tier, "confidence": np.where(near, 0.5, 0.8), "needs_review": review}, index=df.index
    )


def predict_with(artifact: dict, df: pd.DataFrame) -> pd.DataFrame:
    from triage.train import candidates  # local import: train imports this module's deps

    out = predict_baseline(df)  # conservative upper-bound rule; the model may only demote from here
    cand = candidates(df)
    p_elevated = np.full(len(df), np.nan)
    if cand.any():
        X = build_features(df)[artifact["columns"]][cand]
        p_elevated[cand] = artifact["model"].predict_proba(X)[:, 1]
    t = artifact["threshold"]
    demote = cand & (p_elevated < t)
    tier = np.where(demote, Tier.SAFE, out["pred_tier"].to_numpy())
    # Near the threshold (within 2x either side) -> flag for a human, keep Elevated.
    near = cand & ~demote & (p_elevated < 2 * t)
    review = (near | dilution_flag(df)) & (tier < Tier.CRITICAL)
    confidence = np.where(cand, np.where(demote, 1 - p_elevated, np.maximum(p_elevated, 0.5)), out["confidence"])
    return pd.DataFrame(
        {
            "pred_tier": tier.astype(int),
            "confidence": np.clip(confidence, 0.5, 0.99),
            "needs_review": review,
            "p_elevated": p_elevated,
        },
        index=df.index,
    )


def predict_detailed(df: pd.DataFrame, artifact: dict | None = None) -> pd.DataFrame:
    """predict() plus `p_elevated`: the model's score for demotion candidates (NaN elsewhere, or without a model).

    Same tiers, confidence and needs_review as predict(); certificates (triage.certify) read the score from here.
    """
    artifact = artifact if artifact is not None else load_artifact()
    out = predict_with(artifact, df) if artifact else predict_baseline(df).assign(p_elevated=np.nan)
    out = out[["pred_tier", "confidence", "needs_review", "p_elevated"]].copy()
    # Unknown input means "unknown", not "below threshold": keep at least the rule tier, escalate, flag.
    missing, untrusted = input_flags(df)
    if untrusted.any():
        floor = np.maximum(predict_baseline(df)["pred_tier"].to_numpy(), np.where(missing, Tier.ELEVATED, Tier.SAFE))
        tier = out["pred_tier"].to_numpy()
        out["pred_tier"] = np.where(untrusted, np.maximum(tier, floor), tier).astype(int)
        out["confidence"] = np.where(untrusted, 0.5, out["confidence"])
        out["needs_review"] = out["needs_review"].to_numpy() | untrusted
    return out


def predict(df: pd.DataFrame, artifact: dict | None = None) -> pd.DataFrame:
    return predict_detailed(df, artifact)[["pred_tier", "confidence", "needs_review"]]


def predict_with_certificates(df: pd.DataFrame, artifact: dict | None = None) -> pd.DataFrame:
    """predict() plus a `certificate` column (one dict per row, triage.certify.certify): why each tier holds."""
    from triage.certify import certify

    artifact = artifact if artifact is not None else load_artifact()
    out = predict_detailed(df, artifact)
    rows, preds = df.to_dict("records"), out.to_dict("records")
    certs = [certify(row, pred, artifact) for row, pred in zip(rows, preds, strict=True)]
    return out[["pred_tier", "confidence", "needs_review"]].assign(certificate=pd.Series(certs, index=df.index))
