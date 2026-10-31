"""Tier prediction. Person B owns this file: replace `predict` internals with the trained model.

Contract (keep it stable - evaluate.py, build_events.py and the API depend on it):
    predict(df) -> DataFrame indexed like df with columns
        pred_tier    int  (0 Safe/below threshold, 1 Elevated, 2 Critical)
        confidence   float in [0, 1]
        needs_review bool (uncertain -> escalated, never down-graded)

Current implementation is the conservative baseline: max_risk_estimate is an upper
bound on Pc, so thresholding it can only over-warn on the Pc side. Combined with the
deterministic miss-distance rule.
"""

import numpy as np
import pandas as pd

from triage.tiers import RISK_CRITICAL, RISK_ELEVATED, miss_tier, pc_tier

REVIEW_MARGIN = 0.5  # within half a decade of a Pc threshold -> needs review


def predict(df: pd.DataFrame) -> pd.DataFrame:
    upper = df["max_risk_estimate"].to_numpy(dtype=float)
    tier = np.maximum(pc_tier(upper), miss_tier(df["miss_distance"]))
    near = np.minimum(np.abs(upper - RISK_CRITICAL), np.abs(upper - RISK_ELEVATED)) < REVIEW_MARGIN
    return pd.DataFrame(
        {"pred_tier": tier, "confidence": np.where(near, 0.5, 0.8), "needs_review": near},
        index=df.index,
    )
