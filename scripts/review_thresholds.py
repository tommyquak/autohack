"""Threshold sweep and event-level post-processing for v1, on TRAIN nested event-grouped CV only.

    for r in 0.98 0.985 0.993 0.995 0.997 0.999; do uv run python scripts/review_oof.py --recall $r; done
    uv run python scripts/review_thresholds.py

Every row is the full v1 pipeline refitted per outer fold (its threshold chosen on its own inner folds).
Reports the gate metrics that matter: false alarms, under-tier, *invisible* under-tier (not needs_review and
no later CDM of the event shown at >= its true tier, the definition on origin/detect/v2-visible), the
same restricted to CDMs >= 2 days before TCA (what the test set looks like), and the event queue.
Post-processing variants (persistence of the demotion across an event's CDMs) are scored on the r=0.99 OOF.
Test is never read.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from review_oof import cache_path, load_oof  # noqa: E402

from triage.data import EVENT  # noqa: E402
from triage.tiers import Tier  # noqa: E402

V2 = {
    "recall": "v2@0.992 (from detect/v2-visible commit)",
    "false_alarms": 9185,
    "under_tier": 33,
    "invisible_ut": 20,
    "invisible_events": 7,
}


def invisible(df: pd.DataFrame, pred: np.ndarray, review: np.ndarray) -> np.ndarray:
    """Under-tiered, not needs_review, and no LATER CDM of the same event shown at >= its true tier."""
    y = df["true_tier"].to_numpy()
    ut = np.flatnonzero((pred < y) & ~review)
    out = np.zeros(len(df), bool)
    ev, tt = df[EVENT].to_numpy(), df["time_to_tca"].to_numpy()
    for i in ut:
        later = (ev == ev[i]) & (tt < tt[i])
        out[i] = not (pred[later] >= y[i]).any()
    return out


def gate(name, df, pred, review):
    y = df["true_tier"].to_numpy()
    inv = invisible(df, pred, review)
    far = (df["time_to_tca"] >= 2).to_numpy()
    fa = (y == Tier.SAFE) & (pred >= Tier.ELEVATED)
    base_fa = (y == Tier.SAFE) & (df["baseline_tier"].to_numpy() >= Tier.ELEVATED)
    last = df.groupby(EVENT)["time_to_tca"].transform("min").eq(df["time_to_tca"]).to_numpy()
    return {
        "config": name,
        "false_alarms": int(fa.sum()),
        "fa_removed_pct": round(100 * (1 - fa.sum() / base_fa.sum()), 1),
        "fa_removed_pct_>=2d": round(100 * (1 - fa[far].sum() / base_fa[far].sum()), 1),
        "under_tier": int((pred < y).sum()),
        "ut_events": int(df[EVENT][pred < y].nunique()),
        "invisible_ut": int(inv.sum()),
        "invisible_events": int(df[EVENT][inv].nunique()),
        "ut_>=2d": int(((pred < y) & far).sum()),
        "needs_review": int(review.sum()),
        "flagged_pct": round(100 * float((pred >= 1).mean()), 1),
        "queue_events": int((pred[last] >= 1).sum()),
        "crit_recall": float((pred[y == 2] == 2).mean()),
    }


def persistence_variants(df):
    """Event-level post-processing of the r=0.99 OOF demotions, using EARLIER CDMs only (no look-ahead)."""
    pred0 = df["pred_tier"].to_numpy()
    review0 = df["needs_review"].to_numpy()
    demoted = (df["cand"] & (pred0 < df["baseline_tier"])).to_numpy()
    g = df.groupby(EVENT, sort=False)
    prev_kept = (g["pred_tier"].shift(1).fillna(-1).to_numpy() >= 1) & g["cand"].shift(1, fill_value=False).to_numpy()
    prev_cand = g["cand"].shift(1, fill_value=False).to_numpy()
    rows = []
    # A: never demote right after an earlier candidate CDM of the same event was kept Elevated
    pa = np.where(demoted & prev_kept, df["baseline_tier"].to_numpy(), pred0)
    rows.append(gate("v1 + no demotion right after a kept CDM", df, pa, review0))
    # B: flag (needs_review) a demotion that follows a kept CDM, tier unchanged
    rows.append(gate("v1 + review flag on demotion after a kept CDM", df, pred0, review0 | (demoted & prev_kept)))
    # C: flag every first demotion of an event (previous CDM not a demoted candidate)
    prev_dem = pd.Series(demoted).groupby(df[EVENT].to_numpy()).shift(1, fill_value=False).to_numpy()
    rows.append(gate("v1 + review flag on first demotion in event", df, pred0, review0 | (demoted & ~prev_dem)))
    # D: score smoothing - demote only if the earlier candidate's score was also below its threshold
    p = df["p_elevated"].to_numpy()
    t = df["threshold"].to_numpy()
    prev_p = pd.Series(p).groupby(df[EVENT].to_numpy()).shift(1).to_numpy()
    both_low = demoted & (~prev_cand | (prev_p < t))
    pd_ = np.where(demoted & ~both_low, df["baseline_tier"].to_numpy(), pred0)
    rows.append(gate("v1 + demote only if previous candidate score also < t", df, pd_, review0))
    return rows


def main():
    pd.set_option("display.width", 250)
    rows = []
    for r in [0.98, 0.985, None, 0.993, 0.995, 0.997, 0.999]:
        if not cache_path(r).exists():
            print(f"skip recall {r}: run scripts/review_oof.py --recall {r}")
            continue
        df = load_oof(r)
        rows.append(gate(f"v1@{r or 0.99}", df, df["pred_tier"].to_numpy(), df["needs_review"].to_numpy()))
    base = load_oof()
    rows.insert(
        0, gate("Pc bound rule (status quo)", base, base["baseline_tier"].to_numpy(), np.zeros(len(base), bool))
    )
    rows += persistence_variants(base)
    print("Nested event-grouped CV on train (162,634 CDMs). Test never read.")
    print(pd.DataFrame(rows).to_string(index=False))
    print(f"\nFor reference, {V2}")
    scale = 24_484 / 162_634
    print(
        f"Test-equivalent scale factor {scale:.4f}: v1 CV under-tier 39 -> ~{39 * scale:.1f} expected on test; "
        f"v2 33 -> ~{33 * scale:.1f}. Observed on test: v1 1, v2 3."
    )


if __name__ == "__main__":
    main()
