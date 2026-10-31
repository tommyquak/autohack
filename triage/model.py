"""Tier prediction behind a stable contract (see docs/CONTRACT.md).

    predict(df) -> DataFrame indexed like df with columns
        pred_tier    int  (0 below threshold, 1 Elevated, 2 Critical)
        confidence   float in [0, 1]
        needs_review bool (uncertain -> escalated, never down-graded)

Uses the trained artifact (reports/model.joblib, from `python -m triage.train`) when present,
otherwise the conservative upper-bound baseline. Either way the deterministic rules hold:
Critical from the upper bound or miss < 1 km can never be removed by the model.
"""

from functools import cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from triage.features import dilution_flag
from triage.tiers import RISK_CRITICAL, RISK_ELEVATED, Tier, miss_tier, pc_tier

ARTIFACT = Path(__file__).resolve().parent.parent / "reports" / "model.joblib"
REVIEW_MARGIN = 0.5  # baseline only: within half a decade of a Pc threshold -> needs review
ENSEMBLE_REVIEW_BAND = 0.05  # v2: kept within 5 percentile points above the demotion threshold -> needs review


@cache
def load_artifact(path: Path = ARTIFACT):
    return joblib.load(path) if path.exists() else None


def predict_baseline(df: pd.DataFrame) -> pd.DataFrame:
    upper = df["max_risk_estimate"].to_numpy(dtype=float)
    tier = np.maximum(pc_tier(upper), miss_tier(df["miss_distance"]))
    near = np.minimum(np.abs(upper - RISK_CRITICAL), np.abs(upper - RISK_ELEVATED)) < REVIEW_MARGIN
    return pd.DataFrame(
        {"pred_tier": tier, "confidence": np.where(near, 0.5, 0.8), "needs_review": near}, index=df.index
    )


def predict_with(artifact: dict, df: pd.DataFrame) -> pd.DataFrame:
    from triage.ensemble import score
    from triage.train import candidates, features_for  # local import: train imports this module's deps

    out = predict_baseline(df)  # conservative upper-bound rule; the model may only demote from here
    cand = candidates(df)
    s = np.full(len(df), np.nan)
    if cand.any():
        X = features_for(artifact, df)[artifact["columns"]][cand]
        s[cand] = score(artifact["model"], X)
    t = artifact["threshold"]
    demote = cand & (s < t)
    tier = np.where(demote, Tier.SAFE, out["pred_tier"].to_numpy())
    if artifact.get("kind", "classifier") == "ensemble":
        # s is a mean OOF percentile in [0, 1]: kept but within 5 points of the threshold -> human review
        near = cand & ~demote & (s < t + ENSEMBLE_REVIEW_BAND)
        model_conf = 0.5 + 0.49 * np.minimum(1.0, np.abs(s - t) / 0.25)
    else:
        # s is P(Elevated): kept but within 2x of the threshold -> human review
        near = cand & ~demote & (s < 2 * t)
        model_conf = np.where(demote, 1 - s, np.maximum(s, 0.5))
    review = (near | dilution_flag(df)) & (tier < Tier.CRITICAL)
    confidence = np.where(cand, model_conf, out["confidence"])
    return pd.DataFrame(
        {
            "pred_tier": tier.astype(int),
            "confidence": np.clip(confidence, 0.5, 0.99),
            "needs_review": review,
            "score": s,
        },
        index=df.index,
    )


def predict(df: pd.DataFrame, artifact: dict | None = None) -> pd.DataFrame:
    artifact = artifact if artifact is not None else load_artifact()
    out = predict_with(artifact, df) if artifact else predict_baseline(df)
    return out[["pred_tier", "confidence", "needs_review"]]
