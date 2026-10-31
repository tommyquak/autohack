"""Evaluate baselines and the model. Writes reports/metrics.json (schema: docs/CONTRACT.md).

uv run python -m triage.evaluate                  # data/raw, test set if it has labels
uv run python -m triage.evaluate --data data/sample/cdm_sample.csv
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score

from triage import model
from triage.data import RAW_DIR, find_csv, load_cdms
from triage.tiers import Tier, miss_tier, pc_tier

REPORTS = Path(__file__).resolve().parent.parent / "reports"
LEAD_BUCKETS = [(0, 1), (1, 2), (2, 4), (4, 7)]  # days before TCA


def baselines(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {
        "majority_class": np.full(len(df), int(df["true_tier"].mode()[0])),
        "miss_distance_rule": miss_tier(df["miss_distance"]),
        "max_risk_estimate_rule": np.maximum(pc_tier(df["max_risk_estimate"]), miss_tier(df["miss_distance"])),
    }


def score(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    labels = [Tier.SAFE, Tier.ELEVATED, Tier.CRITICAL]
    is_crit, pred_crit = y_true == Tier.CRITICAL, y_pred == Tier.CRITICAL
    return {
        "n": int(len(y_true)),
        "critical_recall": float(recall_score(is_crit, pred_crit, zero_division=0)),
        "critical_precision": float(precision_score(is_crit, pred_crit, zero_division=0)),
        "false_alarm_rate": float(pred_crit[~is_crit].mean()) if (~is_crit).any() else 0.0,
        "macro_f1": float(f1_score(y_true, y_pred, labels=labels, average="macro", zero_division=0)),
        # Operator workload: share of CDMs flagged Elevated or Critical (need a human look)
        "flagged_rate": float((y_pred >= Tier.ELEVATED).mean()),
        # The dangerous error: CDM shown at a lower tier than its truth
        "under_tier_rate": float((y_pred < y_true).mean()),
        "confusion": confusion_matrix(y_true, y_pred, labels=labels).tolist(),
    }


def by_lead_time(df: pd.DataFrame, y_pred: np.ndarray) -> list[dict]:
    out = []
    for lo, hi in LEAD_BUCKETS:
        mask = ((df["time_to_tca"] >= lo) & (df["time_to_tca"] < hi)).to_numpy()
        if mask.any():
            out.append({"days_to_tca": [lo, hi], **score(df["true_tier"].to_numpy()[mask], y_pred[mask])})
    return out


def missed_criticals(df: pd.DataFrame, y_pred: np.ndarray, limit: int = 5) -> list[dict]:
    miss = df[(df["true_tier"] == Tier.CRITICAL).to_numpy() & (y_pred != Tier.CRITICAL)]
    cols = ["event_id", "time_to_tca", "miss_distance", "max_risk_estimate", "risk"]
    return miss.sort_values("risk", ascending=False)[cols].head(limit).to_dict("records")


def evaluate(df: pd.DataFrame, split: str) -> dict:
    y = df["true_tier"].to_numpy()
    preds = {**baselines(df), "model": model.predict(df)["pred_tier"].to_numpy()}
    return {
        "split": split,
        "class_counts": {t.name: int((y == t).sum()) for t in Tier},
        "results": {name: score(y, p) for name, p in preds.items()},
        "by_lead_time": {name: by_lead_time(df, p) for name, p in preds.items()},
        "missed_criticals": missed_criticals(df, preds["model"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="CSV path; default: test (or train) CSV under data/raw")
    args = ap.parse_args()
    if args.data:
        path, split = Path(args.data), Path(args.data).stem
    else:
        path, split = find_csv("test", RAW_DIR), "test"
        if "risk" not in pd.read_csv(path, nrows=1).columns:  # unlabeled test set -> report on train
            path, split = find_csv("train", RAW_DIR), "train"
    report = evaluate(load_cdms(path), split)
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "metrics.json").write_text(json.dumps(report, indent=2, default=float))

    print(f"{split}: {report['class_counts']}")
    print(f"{'method':<24}{'crit recall':>12}{'false alarm':>12}{'macro F1':>10}")
    for name, r in report["results"].items():
        print(f"{name:<24}{r['critical_recall']:>12.3f}{r['false_alarm_rate']:>12.3f}{r['macro_f1']:>10.3f}")


if __name__ == "__main__":
    main()
