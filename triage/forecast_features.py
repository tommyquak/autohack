"""Official task inputs: organisers' event labels, the >= 2-day cut, and one feature row per event.

The organisers' task (data/raw/labels/challenge1_event_labels.xlsx, sheet data_notes): predict each event's FINAL
tier (its last message before closest approach) using ONLY messages with time_to_tca >= 2 days.

    load_labels(path)          -> one row per train event: final_tier (0/1/2), usable (bool), final_* columns
    label_agreement(labels, df) -> how often the xlsx final_tier matches the tier recomputed from train_data
    cutoff_inputs(df)          -> only the messages with time_to_tca >= 2 days, only event_id + allowed columns
    event_features(inputs, nowcast) -> one row per event (no risk, nothing from a message < 2 days out)

`risk` is the label column: it never reaches event_features (the inputs are cut to [event_id, *FEATURES] first).
"""

from pathlib import Path

import numpy as np
import pandas as pd

from triage.data import CATEGORIES, EVENT, FEATURES, LABEL, RAW_DIR
from triage.features import SIGMA_SENTINEL_M
from triage.tiers import Tier, miss_tier, pc_tier, true_tier

CUTOFF_DAYS = 2.0
LABELS_XLSX = RAW_DIR / "labels" / "challenge1_event_labels.xlsx"
LABEL_SHEET = "train_event_labels"
XLSX_TIER = {"Safe": Tier.SAFE, "Elevated": Tier.ELEVATED, "Critical": Tier.CRITICAL}  # xlsx "Safe" = below threshold
FORBIDDEN = {LABEL, "true_tier", "mission_id"}  # never model inputs
NOT_MODEL_INPUTS = {"nowcast_untrusted"}  # kept on the feature row for the decision record only


# ---------- labels ----------


def load_labels(path: Path | str = LABELS_XLSX) -> pd.DataFrame:
    """The organisers' per-event labels (header on row 3 of the sheet), with final_tier mapped to 0/1/2.

    The xlsx calls tier 0 "Safe"; we keep the code (0) and always display it as "Below threshold".
    """
    raw = pd.read_excel(path, sheet_name=LABEL_SHEET, header=2)
    need = {"event_id", "final_tier", "usable_for_training"}
    missing = need - set(raw.columns)
    if missing:
        raise ValueError(f"{path}: sheet {LABEL_SHEET!r} lacks columns {sorted(missing)}")
    raw = raw.dropna(subset=["event_id"])
    unknown = set(raw["final_tier"]) - set(XLSX_TIER)
    if unknown:
        raise ValueError(f"{path}: unknown final_tier values {sorted(map(str, unknown))}")
    out = raw.rename(columns={"final_tier": "final_tier_xlsx"}).copy()
    out["event_id"] = out["event_id"].astype(int)
    out["final_tier"] = out["final_tier_xlsx"].map(XLSX_TIER).astype(int)
    out["usable"] = out["usable_for_training"].astype(str).str.strip().str.lower().eq("yes")
    return out.set_index("event_id").sort_index()


def final_messages(df: pd.DataFrame) -> pd.DataFrame:
    """The last message of each event (smallest time_to_tca), indexed by event_id."""
    return df.loc[df.groupby(EVENT)["time_to_tca"].idxmin()].set_index(EVENT)


def label_agreement(labels: pd.DataFrame, df: pd.DataFrame) -> dict:
    """Cross-check the xlsx final_tier against true_tier(risk, miss) of train_data's last message per event."""
    final = final_messages(df)
    recomputed = pd.Series(true_tier(final[LABEL], final["miss_distance"]), index=final.index)
    common = labels.index.intersection(recomputed.index)
    a, b = labels.loc[common, "final_tier"].to_numpy(), recomputed.loc[common].to_numpy()
    usable = labels.loc[common, "usable"].to_numpy()
    n_inputs = df[df["time_to_tca"] >= CUTOFF_DAYS].groupby(EVENT).size()
    has_input = pd.Series(common.isin(n_inputs.index), index=common)
    confusion = pd.crosstab(pd.Series(a, name="xlsx"), pd.Series(b, name="recomputed")).reindex(
        index=range(3), columns=range(3), fill_value=0
    )
    return {
        "events_in_xlsx": int(len(labels)),
        "events_in_train_data": int(len(recomputed)),
        "matched": int(len(common)),
        "agree": int((a == b).sum()),
        "agreement": float((a == b).mean()) if len(common) else 0.0,
        "confusion_xlsx_rows_recomputed_cols": confusion.to_numpy().tolist(),
        "usable_yes": int(usable.sum()),
        "usable_matches_has_message_2d_or_more": bool((usable == has_input.to_numpy()).all()),
        "final_tier_counts_usable": {
            name: int(((a == t) & usable).sum())
            for t, name in zip(Tier, ["below", "elevated", "critical"], strict=True)
        },
    }


# ---------- inputs ----------


def cutoff_inputs(df: pd.DataFrame, cutoff: float = CUTOFF_DAYS) -> pd.DataFrame:
    """Only messages with time_to_tca >= cutoff, and only event_id + the allowed columns (no risk, no labels)."""
    keep = df.loc[df["time_to_tca"] >= cutoff, [EVENT, *FEATURES]]
    return keep.sort_values([EVENT, "time_to_tca"], ascending=[True, False]).reset_index(drop=True)


def _slope(x: pd.Series, y: pd.Series, groups: pd.Series) -> pd.Series:
    """Least-squares slope of y on x per group (NaN for a single message)."""
    d = pd.DataFrame({"g": groups.to_numpy(), "x": x.to_numpy(), "y": y.to_numpy()})
    d["xc"] = d["x"] - d.groupby("g")["x"].transform("mean")
    d["yc"] = d["y"] - d.groupby("g")["y"].transform("mean")
    d["xy"], d["xx"] = d["xc"] * d["yc"], d["xc"] ** 2
    s = d.groupby("g")[["xy", "xx"]].sum()
    return (s["xy"] / s["xx"].replace(0, np.nan)).rename(None)


# Monotonic constraints the forecaster applies (+1: higher value -> higher final tier). Slopes are left free.
MONOTONIC = {
    "log_miss_latest": -1,
    "log_miss_min": -1,
    "mre_latest": 1,
    "mre_max": 1,
    "rule_tier": 1,
    "miss_tier": 1,
    "pc_bound_tier": 1,
    "nowcast_tier": 1,
}


def event_features(inputs: pd.DataFrame, nowcast: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per event from its >= 2-day messages. `nowcast` (optional, indexed by event_id) adds the team's
    per-message tier at the latest message (`nowcast_tier`), its demotion score (`nowcast_p_elevated`) and, for the
    decision record only (never a model input), whether that message had an untrusted input (`nowcast_untrusted`)."""
    if (inputs["time_to_tca"] < CUTOFF_DAYS).any():
        raise ValueError("event_features got a message < 2 days before TCA: pass cutoff_inputs(df)")
    x = inputs[[EVENT, *FEATURES]].sort_values([EVENT, "time_to_tca"], ascending=[True, False])
    g = x.groupby(EVENT, sort=True)
    last, first = g.tail(1).set_index(EVENT), g.head(1).set_index(EVENT)
    log_miss = np.log10(x["miss_distance"].clip(lower=1))
    sig_c = x["c_sigma_r"].where(x["c_sigma_r"] < SIGMA_SENTINEL_M)
    sig_last = sig_c.groupby(x[EVENT]).last()
    sig_first = sig_c.groupby(x[EVENT]).first()
    closer = -x["time_to_tca"]  # slopes per day closer to TCA: negative miss slope = closing
    t_sig_last = last["t_sigma_r"].where(last["t_sigma_r"] < SIGMA_SENTINEL_M)
    f = pd.DataFrame(index=last.index)
    f["n_cdm"] = g.size()
    f["tca_latest"] = last["time_to_tca"]
    f["span_days"] = first["time_to_tca"] - last["time_to_tca"]
    f["miss_latest"] = last["miss_distance"]
    f["log_miss_latest"] = np.log10(last["miss_distance"].clip(lower=1))
    f["log_miss_min"] = log_miss.groupby(x[EVENT]).min()
    f["miss_slope"] = _slope(closer, x["miss_distance"], x[EVENT])
    f["log_miss_slope"] = _slope(closer, log_miss, x[EVENT])
    f["log_miss_change"] = f["log_miss_latest"] - np.log10(first["miss_distance"].clip(lower=1))
    f["mre_latest"] = last["max_risk_estimate"]
    f["mre_max"] = g["max_risk_estimate"].max()
    f["mre_mean"] = g["max_risk_estimate"].mean()
    f["mre_slope"] = _slope(closer, x["max_risk_estimate"], x[EVENT])
    f["log_sigma_c_latest"] = np.log10(sig_last)
    f["log_sigma_t_latest"] = np.log10(t_sig_last)
    f["sigma_c_shrink"] = np.log10(sig_first) - np.log10(sig_last)  # > 0: tracking improved
    f["sigma_placeholder"] = ((last["c_sigma_r"] >= SIGMA_SENTINEL_M) | (last["t_sigma_r"] >= SIGMA_SENTINEL_M)).astype(
        int
    )
    f["relative_speed"] = last["relative_speed"]
    for a in "rtn":
        f[f"rel_{a}"] = last[f"relative_position_{a}"]
    f["F10"], f["AP"] = last["F10"], last["AP"]
    codes = pd.Categorical(last["c_object_type"], categories=CATEGORIES["c_object_type"]).codes
    f["object_type"] = np.where(codes < 0, np.nan, codes)
    f["miss_tier"] = miss_tier(last["miss_distance"])
    f["pc_bound_tier"] = pc_tier(last["max_risk_estimate"])
    f["rule_tier"] = np.maximum(f["miss_tier"], f["pc_bound_tier"])
    if nowcast is not None:
        nc = nowcast.reindex(f.index)
        f["nowcast_tier"] = nc["nowcast_tier"].to_numpy()
        f["nowcast_p_elevated"] = nc["nowcast_p_elevated"].to_numpy()
        if "nowcast_untrusted" in nc:
            f["nowcast_untrusted"] = nc["nowcast_untrusted"].fillna(0).astype(int).to_numpy()
    assert not FORBIDDEN & set(f.columns)
    return f
