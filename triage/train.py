"""Train the demotion classifier with event-grouped CV, pick a recall-guaranteed threshold, save it.

    uv run python -m triage.train            # full train_data.csv -> reports/model.joblib (~30 s)

Where the model acts (and only there): CDMs the conservative baseline marks Elevated *purely*
because the Pc upper bound (max_risk_estimate) is in [1e-6, 1e-4) while miss distance > 5 km.
The classifier estimates P(true Pc >= 1e-6). Rows below a threshold are demoted to "below
threshold". The threshold is the (1 - target) quantile of out-of-fold scores of truly-Elevated
rows, so >= target of them stay Elevated on held-out events (split-conformal style guarantee).
Critical is never touched by the model; diluted covariance is never demoted.
"""

import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

from triage.data import RAW_DIR, find_csv, group_folds, load_cdms
from triage.features import MONOTONIC, build_features, dilution_flag
from triage.tiers import RISK_ELEVATED, Tier, miss_tier, pc_tier

ARTIFACT = Path(__file__).resolve().parent.parent / "reports" / "model.joblib"
RECALL_TARGET = 0.99  # >= 99% of truly-Elevated candidate CDMs must stay Elevated


def candidates(df: pd.DataFrame) -> np.ndarray:
    """Baseline-Elevated only because of the Pc upper bound - the over-warning the model may remove."""
    upper_only = (miss_tier(df["miss_distance"]) == Tier.SAFE) & (pc_tier(df["max_risk_estimate"]) == Tier.ELEVATED)
    return upper_only & ~dilution_flag(df)


def make_model(columns) -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        max_iter=300,
        learning_rate=0.06,
        max_leaf_nodes=31,
        l2_regularization=1.0,
        categorical_features=["c_object_type"],
        monotonic_cst={k: v for k, v in MONOTONIC.items() if k in columns},
        class_weight="balanced",
        random_state=0,
    )


def train(df: pd.DataFrame, n_splits: int = 5, recall_target: float = RECALL_TARGET) -> dict:
    cand = candidates(df)
    sub = df[cand].reset_index(drop=True)
    X = build_features(df)[cand].reset_index(drop=True)
    y = (sub["risk"] >= RISK_ELEVATED).to_numpy()

    oof = np.zeros(len(sub))
    for fold, (tr, va) in enumerate(group_folds(sub, n_splits)):
        oof[va] = make_model(X.columns).fit(X.iloc[tr], y[tr]).predict_proba(X.iloc[va])[:, 1]
        print(f"  fold {fold + 1}/{n_splits} done")

    threshold = float(np.quantile(oof[y], 1 - recall_target)) if y.any() else 0.0
    demoted = oof < threshold
    final = make_model(X.columns).fit(X, y)
    cv = {
        "candidates": int(len(sub)),
        "candidate_positive_rate": float(y.mean()),
        "threshold": threshold,
        "recall_target": recall_target,
        "oof_recall": float((~demoted[y]).mean()) if y.any() else 1.0,
        "oof_false_elevated_removed": float(demoted[~y].mean()) if (~y).any() else 0.0,
        "n_folds": n_splits,
    }
    return {"model": final, "columns": list(X.columns), "threshold": threshold, "cv": cv}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="training CSV (default: train CSV under data/raw)")
    ap.add_argument("--out", default=str(ARTIFACT))
    ap.add_argument("--recall", type=float, default=RECALL_TARGET)
    args = ap.parse_args()
    df = load_cdms(args.data or find_csv("train", RAW_DIR))
    print(f"training on {len(df):,} CDMs / {df['event_id'].nunique():,} events")
    artifact = train(df, recall_target=args.recall)
    Path(args.out).parent.mkdir(exist_ok=True)
    joblib.dump(artifact, args.out)
    print({k: round(v, 4) if isinstance(v, float) else v for k, v in artifact["cv"].items()})
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
