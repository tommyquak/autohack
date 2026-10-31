"""Write predictions/test_final_tier_predictions.xlsx from predictions/test_final_tier.csv and test_data.

    uv run python scripts/export_final_tier_xlsx.py     # after `uv run python -m triage.forecast`

Sheets: predictions (one row per test event, with units and display columns), messages (every test message), notes.
Display-only columns (mission_id, latitude, azimuth, elevation, and `risk` as a reference) are never model inputs.
"""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from triage.data import EVENT, RAW_DIR, find_csv, load_cdms  # noqa: E402
from triage.forecast import PREDICTIONS  # noqa: E402
from triage.tiers import TIER_NAMES, Tier, true_tier  # noqa: E402

OUT = ROOT / "predictions" / "test_final_tier_predictions.xlsx"
METRICS = ROOT / "data" / "demo" / "forecast_metrics.json"


def main():
    pred = pd.read_csv(PREDICTIONS, dtype={"escalation_rule": str}, keep_default_na=False).set_index(EVENT)
    test = load_cdms(find_csv("test", RAW_DIR)).sort_values([EVENT, "time_to_tca"], ascending=[True, False])
    g = test.groupby(EVENT)
    last, first = g.tail(1).set_index(EVENT), g.head(1).set_index(EVENT)
    ref = pd.Series(true_tier(last["risk"], last["miss_distance"]), index=last.index).map(lambda t: TIER_NAMES[Tier(t)])
    rows = pd.DataFrame(
        {
            "event": [f"TEST-{i:04d}" for i in pred.index],
            "event_id (test_data)": pred.index,
            "mission_id": last["mission_id"].reindex(pred.index) if "mission_id" in last else None,
            "predicted final tier": pred["predicted_final_tier_name"],
            "decision": pred["decision"],
            "score: final Critical (ranking score, not a probability)": pred["score_final_critical"],
            "score: final Elevated or worse (ranking score, not a probability)": pred["score_final_elevated_or_worse"],
            "floor tier (rules at latest message)": pred["floor_tier_name"],
            "tier at latest message (risk + miss, reference)": ref.reindex(pred.index),
            "top reason": pred["top_reason"],
            "messages 2+ days out": g.size().reindex(pred.index),
            "latest time_to_tca (days)": last["time_to_tca"].reindex(pred.index),
            "miss_distance (m)": last["miss_distance"].reindex(pred.index),
            "first miss_distance (m)": first["miss_distance"].reindex(pred.index),
        },
        index=pred.index,
    )
    for col, name in [
        ("relative_speed", "relative_speed (m/s)"),
        ("relative_position_r", "relative_position_r (m)"),
        ("relative_position_t", "relative_position_t (m)"),
        ("relative_position_n", "relative_position_n (m)"),
        ("c_object_type", "c_object_type"),
        ("c_sigma_r", "c_sigma_r (m)"),
        ("t_sigma_r", "t_sigma_r (m)"),
        ("max_risk_estimate", "max_risk_estimate (log10 Pc upper bound)"),
        ("risk", "risk (log10 Pc, label; -30 = Pc ~ 0)"),
        ("F10", "F10 (sfu)"),
        ("AP", "AP"),
        ("geocentric_latitude", "geocentric_latitude (deg)"),
    ]:
        if col in last:
            rows[name] = last[col].reindex(pred.index)
    rows = rows.assign(_esc=pred["predicted_final_tier"] > pred["floor_tier"]).sort_values(
        ["predicted final tier", "_esc", "miss_distance (m)"],
        key=lambda s: (
            s.map({"Critical": 0, "Elevated": 1, "Below threshold": 2}) if s.name == "predicted final tier" else s
        ),
        ascending=[True, False, True],
    )
    rows = rows.drop(columns="_esc")

    msg_cols = {
        EVENT: "event_id (test_data)",
        "time_to_tca": "time_to_tca (days)",
        "miss_distance": "miss_distance (m)",
        "relative_speed": "relative_speed (m/s)",
        "relative_position_r": "relative_position_r (m)",
        "relative_position_t": "relative_position_t (m)",
        "relative_position_n": "relative_position_n (m)",
        "c_object_type": "c_object_type",
        "c_sigma_r": "c_sigma_r (m)",
        "t_sigma_r": "t_sigma_r (m)",
        "max_risk_estimate": "max_risk_estimate (log10)",
        "F10": "F10 (sfu)",
        "AP": "AP",
        "risk": "risk (log10 Pc; -30 = Pc ~ 0)",
        "mission_id": "mission_id",
        "geocentric_latitude": "geocentric_latitude (deg)",
        "azimuth": "azimuth (deg)",
        "elevation": "elevation (deg)",
    }
    messages = test[[c for c in msg_cols if c in test]].rename(columns=msg_cols)

    th = json.loads(METRICS.read_text())["decision_layer"]["shipped_thresholds"]
    counts = pred["predicted_final_tier_name"].value_counts()
    notes = pd.DataFrame(
        [
            (
                "Source data",
                f"test_data.csv: all {len(pred):,} test events, {len(test):,} messages (every message is 2+ "
                "days before closest approach)",
            ),
            (
                "Method",
                "triage/forecast.py, labels from challenge1_event_labels.xlsx (11,942 usable train events); rows "
                "from predictions/test_final_tier.csv",
            ),
            (
                "Task",
                "Predict each event's FINAL tier (last message before closest approach) using only messages with "
                "time_to_tca >= 2 days. risk is never an input.",
            ),
            (
                "Decision",
                "floor = rule tier at the latest 2+ day message, raised to the dashboard nowcast tier (Critical "
                "never lowered); the model may only escalate: Critical if score(final Critical) >= t_crit, else "
                "Elevated if score(final Elevated or worse) >= t_elev",
            ),
            (
                "Thresholds",
                f"t_crit = {th['t_crit']:.4f} (set on out-of-fold training scores for a "
                f"{th['critical_recall_target']:.0%} final-Critical recall target, a target, not a guarantee); "
                f"t_elev = {th['t_elev']:.4f} (maximises F2 of final Elevated-or-worse)",
            ),
            (
                "Scores",
                "Scores from a class-weighted model: they rank events but overstate rare tiers; they are not "
                "calibrated probabilities",
            ),
            (
                "Counts",
                f"{counts.get('Critical', 0)} Critical, {counts.get('Elevated', 0)} Elevated, "
                f"{counts.get('Below threshold', 0)} below threshold; "
                f"{int((pred['predicted_final_tier'] > pred['floor_tier']).sum())} escalated above the floor",
            ),
            ("Not scored", "test_data has no final outcomes; these are demo predictions"),
            ("Wording", "Tier 0 is 'below threshold', never 'safe'. Nothing here advises a manoeuvre."),
            (
                "Units",
                "miss_distance and relative_position_* in metres; relative_speed m/s; time_to_tca days; "
                "max_risk_estimate and risk log10(Pc)",
            ),
            (
                "Location columns",
                "geocentric_latitude, azimuth, elevation kept from test_data for display only (not "
                "model inputs). The data has no longitude column.",
            ),
            ("event_id", "IDs restart in each file: TEST-0482 is test event 482, not train event 482"),
        ],
        columns=["topic", "detail"],
    )
    with pd.ExcelWriter(OUT, engine="openpyxl") as xw:
        rows.to_excel(xw, sheet_name="predictions", index=False)
        messages.to_excel(xw, sheet_name="messages", index=False)
        notes.to_excel(xw, sheet_name="notes", index=False)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} events, {len(messages)} messages")


if __name__ == "__main__":
    main()
