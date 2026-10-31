"""Build reports/events.json for the dashboard (schema: docs/CONTRACT.md).

uv run python -m triage.build_events --data data/sample/cdm_sample.csv
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from triage import model
from triage.data import EVENT, RAW_DIR, find_csv, load_cdms
from triage.tiers import MISS_CRITICAL_M, TIER_NAMES, Tier, miss_tier, pc_tier, reasons

REPORTS = Path(__file__).resolve().parent.parent / "reports"
WARNING_WINDOW_DAYS = 1.0  # "in a 24 hour frame"


def build(df: pd.DataFrame) -> dict:
    df = df.join(model.predict(df))
    # The conservative rule the model improves on: worse of the Pc upper bound and miss distance.
    df["baseline_tier"] = np.maximum(pc_tier(df["max_risk_estimate"]), miss_tier(df["miss_distance"]))
    events = []
    for event_id, g in df.groupby(EVENT, sort=False):
        g = g.sort_values("time_to_tca", ascending=False)
        last = g.iloc[-1]
        events.append(
            {
                "event_id": int(event_id),
                "tier": int(last["pred_tier"]),
                "tier_name": TIER_NAMES[Tier(int(last["pred_tier"]))],
                "baseline_tier": int(last["baseline_tier"]),
                "confidence": float(last["confidence"]),
                "needs_review": bool(last["needs_review"]),
                "reasons": reasons(float(last["max_risk_estimate"]), float(last["miss_distance"])),
                "latest": {
                    "time_to_tca_days": float(last["time_to_tca"]),
                    "miss_distance_m": float(last["miss_distance"]),
                    "relative_speed_ms": float(last["relative_speed"]),
                    "relative_position_rtn_m": [float(last[f"relative_position_{a}"]) for a in "rtn"],
                    "sigma_r_m": {"chaser": float(last["c_sigma_r"]), "target": float(last["t_sigma_r"])},
                    "max_risk_estimate_log10": float(last["max_risk_estimate"]),
                    "object_type": str(last["c_object_type"]),
                },
                "true_tier": int(last["true_tier"]) if "true_tier" in g else None,
                "history": [
                    {
                        "time_to_tca_days": float(r.time_to_tca),
                        "miss_distance_m": float(r.miss_distance),
                        "max_risk_estimate_log10": float(r.max_risk_estimate),
                        "risk_log10": float(r.risk) if "risk" in g else None,
                        "pred_tier": int(r.pred_tier),
                        "baseline_tier": int(r.baseline_tier),
                    }
                    for r in g.itertuples()
                ],
            }
        )
    # Most urgent first: tier, then soonest TCA.
    events.sort(key=lambda e: (-e["tier"], e["latest"]["time_to_tca_days"]))
    window = [e for e in events if e["latest"]["time_to_tca_days"] <= WARNING_WINDOW_DAYS]
    summary = {
        "n_events": len(events),
        "by_tier": {TIER_NAMES[t]: sum(e["tier"] == t for e in events) for t in Tier},
        "by_baseline_tier": {TIER_NAMES[t]: sum(e["baseline_tier"] == t for e in events) for t in Tier},
        "needs_review": sum(e["needs_review"] for e in events),
        "warnings_24h": {
            "window_days": WARNING_WINDOW_DAYS,
            "events_in_window": len(window),
            "within_dangerous_distance": sum(e["latest"]["miss_distance_m"] < MISS_CRITICAL_M for e in window),
            "critical_in_window": sum(e["tier"] == Tier.CRITICAL for e in window),
        },
    }
    return {"summary": summary, "events": events}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="CSV path; default: test CSV under data/raw")
    args = ap.parse_args()
    path = Path(args.data) if args.data else find_csv("test", RAW_DIR)
    out = build(load_cdms(path))
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "events.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out["summary"], indent=2))


if __name__ == "__main__":
    main()
