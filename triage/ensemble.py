"""Scoring helpers for the demotion models (own module so pickled artifacts load from anywhere)."""

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor


def raw_score(model, X: pd.DataFrame) -> np.ndarray:
    """Higher = more likely truly Elevated (P(Elevated), or a predicted log10 Pc quantile)."""
    if isinstance(model, HistGradientBoostingRegressor):
        return model.predict(X)
    return model.predict_proba(X)[:, 1]


def ecdf(sorted_ref: np.ndarray, x: np.ndarray) -> np.ndarray:
    return np.searchsorted(sorted_ref, x, side="right") / len(sorted_ref)


class RankEnsemble:
    """Average of member scores, each mapped through the ECDF of that member's out-of-fold scores."""

    def __init__(self, models, refs):
        self.models = models
        self.refs = [np.sort(r) for r in refs]

    def score(self, X: pd.DataFrame) -> np.ndarray:
        return np.mean([ecdf(ref, raw_score(m, X)) for m, ref in zip(self.models, self.refs, strict=True)], axis=0)


def score(model, X: pd.DataFrame) -> np.ndarray:
    return model.score(X) if isinstance(model, RankEnsemble) else raw_score(model, X)
