"""Row-level predictions for a CDM file, in the file's original row order (the challenge scores test_data).

uv run python -m triage.predict                       # test CSV under data/raw -> predictions/test_predictions.csv
uv run python -m triage.predict --data new.csv --out out.csv

Works on unlabeled files: only the allowed columns are read. Columns written:
row (0-based row in the input), event_id, time_to_tca, pred_tier (0 below threshold / 1 Elevated / 2 Critical),
pred_tier_name, confidence, needs_review, baseline_tier (the conservative max_risk_estimate + miss-distance rule).
"""

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from triage import model
from triage.data import EVENT, FEATURES, RAW_DIR, find_csv, read_cdm_csv
from triage.tiers import TIER_NAMES, Tier, miss_tier, pc_tier

OUT = Path(__file__).resolve().parent.parent / "predictions" / "test_predictions.csv"


def predict_file(path: Path | str) -> pd.DataFrame:
    df = read_cdm_csv(path)[[EVENT, *FEATURES]]  # raises ValueError with a clear message on bad input
    # History features need each event ordered oldest CDM first; keep the original index to restore row order.
    ordered = df.sort_values([EVENT, "time_to_tca"], ascending=[True, False], kind="stable")
    pred = model.predict(ordered).sort_index()
    out = pd.DataFrame({"row": df.index, EVENT: df[EVENT], "time_to_tca": df["time_to_tca"]})
    out["pred_tier"] = pred["pred_tier"].astype(int)
    out["pred_tier_name"] = out["pred_tier"].map(lambda t: TIER_NAMES[Tier(t)])
    out["confidence"] = pred["confidence"].round(4)
    out["needs_review"] = pred["needs_review"].astype(bool)
    baseline = np.maximum(pc_tier(df["max_risk_estimate"]), miss_tier(df["miss_distance"]))
    missing, _ = model.input_flags(df)  # the rule cannot clear a CDM whose Pc or miss distance is unknown
    out["baseline_tier"] = np.where(missing, np.maximum(baseline, Tier.ELEVATED), baseline)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="CSV path; default: test CSV under data/raw")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    out = predict_file(Path(args.data) if args.data else find_csv("test", RAW_DIR))
    Path(args.out).parent.mkdir(exist_ok=True)
    out.to_csv(args.out, index=False)
    print(f"{len(out):,} rows -> {args.out}")
    print(out["pred_tier_name"].value_counts().to_string())


if __name__ == "__main__":
    main()
