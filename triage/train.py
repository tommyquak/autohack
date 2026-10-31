"""Train the demotion model with event-grouped CV, pick a recall-guaranteed threshold, save it.

    uv run python -m triage.train                 # full train_data.csv -> reports/model.joblib (v2)
    uv run python -m triage.train --config v1     # reproduce the v1 model

Where the model acts (and only there): CDMs the conservative baseline marks Elevated *purely*
because the Pc upper bound (max_risk_estimate) is in [1e-6, 1e-4) while miss distance > 5 km.
The model scores how likely the true Pc is >= 1e-6. Rows scoring below a threshold are demoted to
"below threshold". The threshold is the (1 - target) quantile of out-of-fold scores of
truly-Elevated rows, so >= target of them stay Elevated on held-out events (split-conformal
style guarantee). Critical is never touched by the model; diluted covariance is never demoted.

Configs (identical candidate set, threshold rule and safety rails; only the scorer differs):
    v1  HistGradientBoostingClassifier P(risk >= -6) on build_features.
    v2  build_features_v2 (v1 + geometry and earlier-CDM history features) and a rank ensemble of
        a larger P(risk >= -6) classifier and a 90%-quantile regressor of log10 Pc (uses the
        continuous label, not only its sign). Each member's score is mapped through the ECDF of
        its own out-of-fold scores and the two are averaged, so the score lives on [0, 1].
        Recall target 0.992 (v1: 0.99).

Nested event-grouped CV on train (scripts/cv_compare.py, 162,634 CDMs, test set never read):
    v1@0.99   under-tier 39   false Elevated 10,049   flagged 34.9%   critical recall 100%
    v2@0.992  under-tier 33   false Elevated  9,185   flagged 34.4%   critical recall 100%
    (matched recall 0.992: v1 33 / 10,594 vs v2 33 / 9,185 -> -13% false Elevated)
"""

import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

from triage.data import RAW_DIR, find_csv, group_folds, load_cdms
from triage.ensemble import RankEnsemble, ecdf, raw_score
from triage.features import MONOTONIC, build_features, build_features_v2, dilution_flag
from triage.tiers import RISK_ELEVATED, Tier, miss_tier, pc_tier

ARTIFACT = Path(__file__).resolve().parent.parent / "reports" / "model.joblib"
RECALL_TARGET = 0.99  # >= 99% of truly-Elevated candidate CDMs must stay Elevated
RISK_CLIP = (-30.0, -4.0)  # regression target range: below 1e-30 is "no risk", candidates are < 1e-4

FEATURE_SETS = {"v1": build_features, "v2": build_features_v2}
_BASE = dict(max_iter=300, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0)
CONFIGS = {
    "v1": {"features": "v1", "members": [{"kind": "classifier", "params": _BASE}]},
    "v2": {
        "features": "v2",
        # Stronger scorer -> afford a stricter recall target and still demote more false alarms than v1@0.99
        "recall_target": 0.992,
        "members": [
            {"kind": "classifier", "params": {**_BASE, "max_leaf_nodes": 63, "min_samples_leaf": 20}},
            {"kind": "regressor", "params": {**_BASE, "loss": "quantile", "quantile": 0.9}},
        ],
    },
}
DEFAULT_CONFIG = "v2"


def candidates(df: pd.DataFrame) -> np.ndarray:
    """Baseline-Elevated only because of the Pc upper bound - the over-warning the model may remove."""
    upper_only = (miss_tier(df["miss_distance"]) == Tier.SAFE) & (pc_tier(df["max_risk_estimate"]) == Tier.ELEVATED)
    return upper_only & ~dilution_flag(df)


def features_for(artifact_or_config: dict, df: pd.DataFrame) -> pd.DataFrame:
    return FEATURE_SETS[artifact_or_config.get("features", "v1")](df)


def make_model(columns, member: dict | None = None):
    member = member or CONFIGS["v1"]["members"][0]
    common = dict(
        categorical_features=["c_object_type"],
        monotonic_cst={k: v for k, v in MONOTONIC.items() if k in columns},
        random_state=0,
        **member["params"],
    )
    if member["kind"] == "regressor":
        return HistGradientBoostingRegressor(**common)
    return HistGradientBoostingClassifier(class_weight="balanced", **common)


def member_target(sub: pd.DataFrame, member: dict) -> np.ndarray:
    if member["kind"] == "regressor":
        return sub["risk"].clip(*RISK_CLIP).to_numpy()
    return (sub["risk"] >= RISK_ELEVATED).to_numpy()


def train(
    df: pd.DataFrame,
    n_splits: int = 5,
    recall_target: float | None = None,
    config: str = DEFAULT_CONFIG,
    verbose: bool = True,
) -> dict:
    cfg = CONFIGS[config]
    recall_target = recall_target if recall_target is not None else cfg.get("recall_target", RECALL_TARGET)
    members = cfg["members"]
    cand = candidates(df)
    sub = df[cand].reset_index(drop=True)
    X = features_for(cfg, df)[cand].reset_index(drop=True)
    y = (sub["risk"] >= RISK_ELEVATED).to_numpy()
    targets = [member_target(sub, m) for m in members]

    member_oof = np.zeros((len(members), len(sub)))
    for fold, (tr, va) in enumerate(group_folds(sub, n_splits)):
        for j, (m, t) in enumerate(zip(members, targets, strict=True)):
            member_oof[j, va] = raw_score(make_model(X.columns, m).fit(X.iloc[tr], t[tr]), X.iloc[va])
        if verbose:
            print(f"  fold {fold + 1}/{n_splits} done")

    finals = [make_model(X.columns, m).fit(X, t) for m, t in zip(members, targets, strict=True)]
    if len(members) == 1:
        model, oof = finals[0], member_oof[0]
    else:
        model = RankEnsemble(finals, member_oof)
        oof = np.mean([ecdf(ref, o) for ref, o in zip(model.refs, member_oof, strict=True)], axis=0)

    threshold = float(np.quantile(oof[y], 1 - recall_target)) if y.any() else -np.inf
    demoted = oof < threshold
    cv = {
        "config": config,
        "candidates": int(len(sub)),
        "candidate_positive_rate": float(y.mean()),
        "threshold": threshold,
        "recall_target": recall_target,
        "oof_recall": float((~demoted[y]).mean()) if y.any() else 1.0,
        "oof_false_elevated_removed": float(demoted[~y].mean()) if (~y).any() else 0.0,
        "n_folds": n_splits,
    }
    kind = "ensemble" if len(members) > 1 else members[0]["kind"]
    return {
        "model": model,
        "columns": list(X.columns),
        "features": cfg["features"],
        "kind": kind,
        "threshold": threshold,
        "cv": cv,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="training CSV (default: train CSV under data/raw)")
    ap.add_argument("--out", default=str(ARTIFACT))
    ap.add_argument("--recall", type=float, help="recall target (default: the config's)")
    ap.add_argument("--config", default=DEFAULT_CONFIG, choices=sorted(CONFIGS))
    args = ap.parse_args()
    df = load_cdms(args.data or find_csv("train", RAW_DIR))
    print(f"training {args.config} on {len(df):,} CDMs / {df['event_id'].nunique():,} events")
    artifact = train(df, recall_target=args.recall, config=args.config)
    Path(args.out).parent.mkdir(exist_ok=True)
    joblib.dump(artifact, args.out)
    print({k: round(v, 4) if isinstance(v, float) else v for k, v in artifact["cv"].items()})
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
