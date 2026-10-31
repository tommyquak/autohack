"""Operator-visible gate on TEST: list every under-tiered CDM and whether an analyst still sees it.

    uv run python scripts/visible_gate.py                          # v1@0.99 and v2@0.992
    uv run python scripts/visible_gate.py --specs v1@0.99 v2@0.992~0.15

Spec: CONFIG[@RECALL][~REVIEW_BAND]. Each model is trained on the full TRAIN set (same code path as
`python -m triage.train`) and applied once to the test set. For each under-tiered CDM the script
records needs_review, the event's tier at its latest CDM, the max tier at any later CDM, the delay
until a later CDM shows the true tier, and the baseline (max_risk_estimate rule) tier.
`risk` is used only for the true tier (label) and is printed for context, never used as an input.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from triage.data import EVENT, RAW_DIR, find_csv, load_cdms  # noqa: E402
from triage.model import predict_baseline, predict_with  # noqa: E402
from triage.train import train  # noqa: E402
from triage.visibility import gate_metrics, visibility  # noqa: E402


def parse(spec: str):
    rest, _, band = spec.partition("~")
    config, _, recall = rest.partition("@")
    return config, (float(recall) if recall else None), (float(band) if band else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--specs", nargs="+", default=["v1@0.99", "v2@0.992"])
    ap.add_argument("--out", help="optional JSON output path")
    args = ap.parse_args()

    train_df = load_cdms(find_csv("train", RAW_DIR))
    test = load_cdms(find_csv("test", RAW_DIR))
    base = predict_baseline(test)["pred_tier"].to_numpy()
    latest_idx = test.groupby(EVENT)["time_to_tca"].idxmin()
    report = {}
    for spec in args.specs:
        config, recall, band = parse(spec)
        artifact = train(train_df, config=config, recall_target=recall, verbose=False)
        if band is not None:
            artifact["review_band"] = band
        out = predict_with(artifact, test)
        pred, review = out["pred_tier"].to_numpy(), out["needs_review"].to_numpy()
        v = visibility(test, pred, review)
        latest_pred = test[EVENT].map(dict(zip(test.loc[latest_idx, EVENT], pred[latest_idx], strict=True)))
        rows = []
        for i in np.flatnonzero(v["under"].to_numpy()):
            r = test.iloc[i]
            rows.append(
                {
                    "event_id": int(r[EVENT]),
                    "time_to_tca": round(float(r["time_to_tca"]), 3),
                    "true_tier": int(r["true_tier"]),
                    "pred_tier": int(pred[i]),
                    "baseline_tier": int(base[i]),
                    "needs_review": bool(review[i]),
                    "score": None if np.isnan(out["score"].iloc[i]) else round(float(out["score"].iloc[i]), 4),
                    "threshold": round(float(artifact["threshold"]), 4),
                    "event_latest_pred": int(latest_pred.iloc[i]),
                    "later_max_pred": int(v["later_max_pred"].iloc[i]),
                    "delay_days": None
                    if np.isnan(v["delay_days"].iloc[i])
                    else round(float(v["delay_days"].iloc[i]), 3),
                    "later_cdm_needs_review": bool(v["later_review"].iloc[i]),
                    "invisible": bool(v["invisible"].iloc[i]),
                    "miss_distance_m": round(float(r["miss_distance"]), 1),
                    "max_risk_estimate": round(float(r["max_risk_estimate"]), 3),
                    "risk_label": round(float(r["risk"]), 3),
                }
            )
        report[spec] = {**gate_metrics(test, pred, review), "threshold": artifact["threshold"], "under_cdms": rows}
        print(f"\n== {spec}  threshold {artifact['threshold']:.4f}")
        print({k: v for k, v in report[spec].items() if k not in ("under_cdms",)})
        for row in rows:
            print("  ", row)
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
