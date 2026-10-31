"""Operator-visible gate: is an under-tiered CDM still in front of an analyst?

An under-tiered CDM (true tier > predicted tier) is *visible* when either
  - it is itself flagged needs_review, or
  - a LATER CDM of the same event (smaller time_to_tca) is shown at >= its true tier,
    so the event is still on the analyst's screen at that tier before closest approach.
It is *invisible* otherwise. Invisible under-tier is the error the gate should count.

Caveat built into the definition: "a later CDM" means the analyst sees the event at the
right tier only once that later CDM arrives (`delay_days` reports how much later).
`risk` is used only to define the true tier (the label); visibility uses predictions only.
"""

import numpy as np
import pandas as pd

from triage.data import EVENT
from triage.features import dilution_flag
from triage.tiers import Tier


def later_max(df: pd.DataFrame, values: np.ndarray) -> np.ndarray:
    """Per CDM: max of `values` over strictly later CDMs of the same event (-1 if none).

    Assumes df is sorted by event, time_to_tca descending (triage.data.load_cdms does this).
    """
    s = pd.Series(values, index=df.index)
    rev = s.iloc[::-1].groupby(df[EVENT].iloc[::-1], sort=False)
    # cummax on the reversed order, shifted by one within the event = max over later rows
    out = rev.transform(lambda x: x.cummax().shift(1)).iloc[::-1]
    return out.fillna(-1).to_numpy().astype(int)


def visibility(df: pd.DataFrame, pred: np.ndarray, review: np.ndarray) -> pd.DataFrame:
    """Per-CDM visibility columns for the under-tier analysis."""
    y = df["true_tier"].to_numpy()
    under = pred < y
    later = later_max(df, pred)
    later_review = later_max(df, review.astype(int)) > 0
    seen_later = later >= y
    invisible = under & ~review & ~seen_later
    # first later CDM of the same event shown at >= the true tier of this CDM: how many days later?
    delay = np.full(len(df), np.nan)
    ev = df[EVENT].to_numpy()
    t = df["time_to_tca"].to_numpy()
    for i in np.flatnonzero(under & seen_later):
        j = i + 1
        while j < len(df) and ev[j] == ev[i]:
            if pred[j] >= y[i]:
                delay[i] = t[i] - t[j]
                break
            j += 1
    return pd.DataFrame(
        {
            "under": under,
            "needs_review": review,
            "later_max_pred": later,
            "seen_later": seen_later,
            "later_review": later_review,
            "invisible": invisible,
            "delay_days": delay,
        },
        index=df.index,
    )


def review_for(df: pd.DataFrame, pred: np.ndarray, score: np.ndarray, threshold: float, kind: str, band) -> np.ndarray:
    """Recompute needs_review for a different review band without refitting (mirrors model.predict_with).

    kind 'ensemble': kept within `band` percentile points above the threshold.
    kind 'classifier': kept with score < band * threshold (v1 default band = 2).
    """
    cand = ~np.isnan(score)
    sc = np.where(cand, score, np.inf)
    kept = cand & (sc >= threshold)
    near = kept & ((sc < threshold + band) if kind == "ensemble" else (sc < band * threshold))
    return (near | dilution_flag(df)) & (pred < Tier.CRITICAL)


def gate_metrics(df: pd.DataFrame, pred: np.ndarray, review: np.ndarray) -> dict:
    y = df["true_tier"].to_numpy()
    v = visibility(df, pred, review)
    crit = y == Tier.CRITICAL
    return {
        "n_cdms": int(len(y)),
        "critical_recall": float((pred[crit] == Tier.CRITICAL).mean()),
        "under_tier": int(v["under"].sum()),
        "under_reviewed": int((v["under"] & v["needs_review"]).sum()),
        "under_seen_later": int((v["under"] & v["seen_later"]).sum()),
        "invisible_under_tier": int(v["invisible"].sum()),
        "invisible_events": int(df.loc[v["invisible"].to_numpy(), EVENT].nunique()),
        "false_elevated": int(((y == Tier.SAFE) & (pred >= Tier.ELEVATED)).sum()),
        "needs_review": int(review.sum()),
        "flagged_rate": float((pred >= Tier.ELEVATED).mean()),
        "confusion": [[int(((y == a) & (pred == b)).sum()) for b in Tier] for a in Tier],
    }
