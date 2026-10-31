"""Compare model configs with nested, event-grouped cross-validation on the TRAIN set only.

    uv run python scripts/cv_compare.py                 # v1 vs v2, 5 outer folds
    uv run python scripts/cv_compare.py --configs v2 --jobs 5

For each outer fold (GroupKFold over event_id on all train CDMs) the FULL pipeline is fitted on
the other folds - including its own inner 5-fold OOF threshold - and then predicts the held-out
events with `triage.model.predict_with`. Nothing ever sees its own validation fold. The test set
is never read. Metrics are computed once over the pooled out-of-fold predictions.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "3")  # several folds run in parallel processes

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
from joblib import Parallel, delayed  # noqa: E402

from triage.data import RAW_DIR, find_csv, group_folds, load_cdms  # noqa: E402
from triage.model import predict_with  # noqa: E402
from triage.tiers import Tier  # noqa: E402
from triage.train import CONFIGS, train  # noqa: E402


def fit_predict(df, tr, va, spec):
    config, _, recall = spec.partition("@")  # "v2" or "v2@0.995" (override the config's recall target)
    recall = float(recall) if recall else None
    artifact = train(df.iloc[tr].reset_index(drop=True), config=config, recall_target=recall, verbose=False)
    pred = predict_with(artifact, df.iloc[va].reset_index(drop=True))["pred_tier"].to_numpy()
    return va, pred, artifact["threshold"]


def metrics(y: np.ndarray, pred: np.ndarray) -> dict:
    crit = y == Tier.CRITICAL
    return {
        "n_cdms": int(len(y)),
        "critical_recall": float((pred[crit] == Tier.CRITICAL).mean()),
        "under_tier": int((pred < y).sum()),
        "under_tier_rate": float((pred < y).mean()),
        "false_elevated": int(((y == Tier.SAFE) & (pred >= Tier.ELEVATED)).sum()),
        "flagged_rate": float((pred >= Tier.ELEVATED).mean()),
        "confusion": [[int(((y == a) & (pred == b)).sum()) for b in Tier] for a in Tier],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="training CSV (default: train CSV under data/raw)")
    ap.add_argument("--configs", nargs="+", default=["v1", "v2"], help=f"{sorted(CONFIGS)}, optionally NAME@RECALL")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--jobs", type=int, default=5)
    ap.add_argument("--out", help="optional JSON output path")
    args = ap.parse_args()

    df = load_cdms(args.data or find_csv("train", RAW_DIR))
    y = df["true_tier"].to_numpy()
    folds = list(group_folds(df, args.folds))
    print(f"{len(df):,} train CDMs / {df['event_id'].nunique():,} events, {args.folds} outer folds")

    for spec in args.configs:
        assert spec.partition("@")[0] in CONFIGS, f"unknown config {spec}"
    report = {}
    for config in args.configs:
        t0 = time.time()
        res = Parallel(n_jobs=args.jobs)(delayed(fit_predict)(df, tr, va, config) for tr, va in folds)
        pred = np.full(len(df), -1)
        for va, p, _ in res:
            pred[va] = p
        assert (pred >= 0).all()
        report[config] = {**metrics(y, pred), "fold_thresholds": [float(t) for _, _, t in res]}
        print(f"{config}: done in {time.time() - t0:.0f}s")

    cols = ["critical_recall", "under_tier", "under_tier_rate", "false_elevated", "flagged_rate", "n_cdms"]
    print(f"{'config':<12}" + "".join(f"{c:>17}" for c in cols))
    for config, r in report.items():
        print(f"{config:<12}" + "".join(f"{r[c]:>17.4f}" if isinstance(r[c], float) else f"{r[c]:>17}" for c in cols))
    for config, r in report.items():
        print(f"{config} confusion (rows truth Safe/Elev/Crit): {r['confusion']}")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
