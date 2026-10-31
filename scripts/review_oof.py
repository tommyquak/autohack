"""Nested event-grouped CV of the shipped v1 pipeline on TRAIN only; caches out-of-fold predictions.

    uv run python scripts/review_oof.py                  # -> reports/review_oof.pkl (~20 s, 5 jobs)
    uv run python scripts/review_oof.py --recall 0.995   # -> reports/review_oof_r0.995.pkl

For each outer fold (GroupKFold over event_id) the full v1 pipeline (`triage.train.train`, including
its own inner 5-fold OOF threshold) is fitted on the other folds and predicts the held-out events
with `triage.model.predict_with`. The test set is never read. Every review_*.py script reads the
cache this writes, so all review numbers come from the same out-of-fold predictions.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "2")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from joblib import Parallel, delayed  # noqa: E402

from triage.data import RAW_DIR, find_csv, group_folds, load_cdms  # noqa: E402
from triage.features import dilution_flag  # noqa: E402
from triage.model import input_flags, predict_with  # noqa: E402
from triage.tiers import miss_tier, pc_tier  # noqa: E402
from triage.train import candidates, train  # noqa: E402

CACHE = Path(__file__).resolve().parent.parent / "reports" / "review_oof.pkl"


def cache_path(recall: float | None) -> Path:
    return CACHE if recall is None else CACHE.with_name(f"review_oof_r{recall:g}.pkl")


def fit_predict(df, fold, tr, va, recall):
    import contextlib
    import io

    with contextlib.redirect_stdout(io.StringIO()):
        art = train(df.iloc[tr].reset_index(drop=True), recall_target=recall)
    out = predict_with(art, df.iloc[va].reset_index(drop=True))
    out.index = va
    out["fold"] = fold
    out["threshold"] = art["threshold"]
    return out


def load_oof(recall: float | None = None) -> pd.DataFrame:
    """Train CDMs (load_cdms order) joined with the cached out-of-fold v1 predictions.

    Applies the same untrusted-input floor as triage.model.predict (11 train CDMs with NaN sigma or
    unknown object type are never demoted and are flagged needs_review).
    """
    df = load_cdms(find_csv("train", RAW_DIR))
    oof = pd.read_pickle(cache_path(recall))
    assert len(oof) == len(df)
    df = df.join(oof)
    df["baseline_tier"] = np.maximum(pc_tier(df["max_risk_estimate"]), miss_tier(df["miss_distance"]))
    _, untrusted = input_flags(df)
    df["pred_tier"] = np.where(untrusted, np.maximum(df["pred_tier"], df["baseline_tier"]), df["pred_tier"])
    df["needs_review"] = df["needs_review"].to_numpy() | untrusted
    df["cand"] = candidates(df)
    df["diluted"] = dilution_flag(df)
    return df


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--recall", type=float, default=None, help="recall target (default: train.py's 0.99)")
    args = ap.parse_args()
    recall = args.recall if args.recall is not None else 0.99
    df = load_cdms(find_csv("train", RAW_DIR))
    print(f"{len(df):,} train CDMs / {df['event_id'].nunique():,} events, recall target {recall}")
    folds = list(group_folds(df, 5))
    res = Parallel(n_jobs=5)(delayed(fit_predict)(df, i, tr, va, recall) for i, (tr, va) in enumerate(folds))
    oof = pd.concat(res).sort_index()
    assert len(oof) == len(df)
    out = cache_path(args.recall)
    out.parent.mkdir(exist_ok=True)
    oof.to_pickle(out)
    print("thresholds per fold:", [round(float(r["threshold"].iloc[0]), 4) for r in res])
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
