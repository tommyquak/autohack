"""Build reports/events.json for the dashboard (schema: docs/CONTRACT.md).

uv run python -m triage.build_events --data data/sample/cdm_sample.csv
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from triage import actions, certify, explain, model
from triage.data import EVENT, RAW_DIR, find_csv, load_cdms
from triage.tiers import MISS_CRITICAL_M, TIER_NAMES, Tier, miss_tier, pc_tier, reasons

REPORTS = Path(__file__).resolve().parent.parent / "reports"
WARNING_WINDOW_DAYS = 1.0  # "in a 24 hour frame"


LAT_BANDS = [(-90, -60), (-60, -30), (-30, 0), (0, 30), (30, 60), (60, 90)]


def _opt(row, col: str) -> float | None:
    return float(row[col]) if col in row.index and pd.notna(row[col]) else None


def latitude_bands(events: list[dict]) -> list[dict] | None:
    """Events per 30-degree band of conjunction-point latitude (display context, not a model input)."""
    lats = [(e["latest"]["geocentric_latitude_deg"], e["tier"]) for e in events]
    if any(lat is None for lat, _ in lats):
        return None
    out = []
    for lo, hi in LAT_BANDS:
        tiers = [t for lat, t in lats if lo <= lat < hi or (hi == 90 and lat == 90)]
        out.append({"lat_deg": [lo, hi], "events": len(tiers), "critical": sum(t == Tier.CRITICAL for t in tiers)})
    return out


def critical_drivers(events: list[dict]) -> dict:
    """Which rule makes each Critical event Critical (latest CDM): miss < 1 km only, Pc bound >= 1e-4 only, or both."""
    out = {"miss_only": 0, "pc_only": 0, "both": 0}
    for e in events:
        if e["tier"] != Tier.CRITICAL:
            continue
        by_pc = pc_tier(e["latest"]["max_risk_estimate_log10"]) == Tier.CRITICAL
        by_miss = miss_tier(e["latest"]["miss_distance_m"]) == Tier.CRITICAL
        out["both" if by_pc and by_miss else "pc_only" if by_pc else "miss_only"] += 1
    return out


def build(df: pd.DataFrame, artifact: dict | None = None) -> dict:
    """events.json content for df. `artifact` overrides the saved nowcast model (used by out-of-fold evaluation)."""
    artifact = artifact if artifact is not None else model.load_artifact()
    df = df.join(model.predict_detailed(df, artifact))
    # The conservative rule the model improves on: worse of the Pc upper bound and miss distance.
    df["baseline_tier"] = np.maximum(pc_tier(df["max_risk_estimate"]), miss_tier(df["miss_distance"]))
    events = []
    for event_id, g in df.groupby(EVENT, sort=False):
        g = g.sort_values("time_to_tca", ascending=False)
        last = g.iloc[-1]
        # Why this tier holds at the latest CDM (rules fired, model eligibility, score vs threshold, invariants)
        cert = certify.certify(last.to_dict(), last.to_dict(), artifact)
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
                    # Display only (not model inputs): conjunction-point latitude and the satellite's altitude band
                    "geocentric_latitude_deg": _opt(last, "geocentric_latitude"),
                    "target_altitude_km": [_opt(last, "t_h_per"), _opt(last, "t_h_apo")]
                    if "t_h_per" in g and "t_h_apo" in g
                    else None,
                },
                "true_tier": int(last["true_tier"]) if "true_tier" in g else None,
                "certificate": cert,
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
    for e in events:
        e["cautions"] = explain.cautions(e)
        e["action"] = actions.action(e)  # reads no label: true_tier / risk_log10 are never used
    # Most urgent first: tier, then soonest TCA.
    events.sort(key=lambda e: (-e["tier"], e["latest"]["time_to_tca_days"]))
    window = [e for e in events if e["latest"]["time_to_tca_days"] <= WARNING_WINDOW_DAYS]
    summary = {
        "n_events": len(events),
        "by_tier": {TIER_NAMES[t]: sum(e["tier"] == t for e in events) for t in Tier},
        "by_baseline_tier": {TIER_NAMES[t]: sum(e["baseline_tier"] == t for e in events) for t in Tier},
        "needs_review": sum(e["needs_review"] for e in events),
        "cautions": {c: sum(c in e["cautions"] for e in events) for c in explain.CAUTIONS},
        "by_latitude_band": latitude_bands(events),
        "critical_drivers": critical_drivers(events),
        "by_action": {q: sum(e["action"]["queue"] == q for e in events) for q in actions.QUEUES},
        "escalation_watch": sum(e["action"]["escalation_watch"] for e in events),
        "warnings_24h": {
            "window_days": WARNING_WINDOW_DAYS,
            "events_in_window": len(window),
            "within_dangerous_distance": sum(e["latest"]["miss_distance_m"] < MISS_CRITICAL_M for e in window),
            "critical_in_window": sum(e["tier"] == Tier.CRITICAL for e in window),
        },
    }
    return {"summary": summary, "events": events, "model_evidence": certify.model_evidence(artifact)}


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
