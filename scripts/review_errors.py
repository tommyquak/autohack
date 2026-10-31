"""Error anatomy and calibration of v1 on TRAIN nested event-grouped CV (reads reports/review_oof.pkl).

    uv run python scripts/review_oof.py && uv run python scripts/review_errors.py

1. Where do the remaining false alarms (truly below threshold, shown Elevated/Critical) come from?
2. Is `confidence` meaningful? Reliability of confidence vs "shown tier == true tier", and of the
   candidate score p_elevated vs the observed rate of truly-Elevated, plus a cross-fitted isotonic
   calibration of p_elevated (grouped by outer fold, so no event calibrates itself).
Test is never read.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from review_oof import load_oof  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402

from triage.tiers import RISK_CRITICAL, RISK_ELEVATED, Tier  # noqa: E402

TEST_SCALE = 24_484 / 162_634  # test CDMs / train CDMs, to translate CV counts into test-equivalents


def cause(df: pd.DataFrame) -> pd.Series:
    b, m = df["max_risk_estimate"], df["miss_distance"]
    c = pd.Series("other", index=df.index)
    c[(df["pred_tier"] == Tier.CRITICAL) & (b >= RISK_CRITICAL)] = "Pc bound >= 1e-4 (Critical, never touched)"
    kept = df["cand"] & (df["pred_tier"] == Tier.ELEVATED)
    c[kept & df["needs_review"]] = "candidate kept, score in [t, 2t) (needs_review)"
    c[kept & ~df["needs_review"]] = "candidate kept, score >= 2t"
    el_bound = (df["pred_tier"] == Tier.ELEVATED) & ~df["cand"] & (b >= RISK_ELEVATED) & (m > 5000)
    c[el_bound & df["diluted"]] = "placeholder sigma (never a candidate)"
    c[el_bound & ~df["diluted"]] = "untrusted input floor (NaN sigma / unknown type)"
    return c


def false_alarm_anatomy(df):
    y, p = df["true_tier"], df["pred_tier"]
    fa = df[(y == Tier.SAFE) & (p >= Tier.ELEVATED)].copy()
    print(f"False alarms on train CV: {len(fa):,} (~{len(fa) * TEST_SCALE:,.0f} test-equivalent; test actual 2,214)")
    fa["cause"] = cause(fa)
    print("\nBy cause:")
    print(fa["cause"].value_counts().to_string())

    k = fa[fa["cand"]].copy()
    t = k["threshold"]
    print(f"\nKept candidates that are false alarms: {len(k):,}")
    ratio = k["p_elevated"] / t
    bins = [1, 1.25, 1.5, 2, 3, 5, 10, np.inf]
    print("score / threshold (how far above the demotion cut):")
    print(pd.cut(ratio, bins, right=False).value_counts().sort_index().to_string())
    print("\nmax_risk_estimate (log10 Pc bound) of kept false alarms:")
    print(pd.cut(k["max_risk_estimate"], [-6, -5.75, -5.5, -5, -4.5, -4]).value_counts().sort_index().to_string())
    print("\ntrue risk (log10 Pc) of kept false alarms:")
    print(pd.cut(k["risk"], [-31, -29.99, -20, -10, -8, -7, -6.5, -6]).value_counts().sort_index().to_string())
    print("\nmiss distance (km) of kept false alarms:")
    print(
        pd.cut(k["miss_distance"] / 1000, [5, 6, 7.5, 10, 15, 25, 50, np.inf]).value_counts().sort_index().to_string()
    )
    sig = np.sqrt(k["c_sigma_r"] ** 2 + k["t_sigma_r"] ** 2)
    print("\ncombined radial sigma (m) of kept false alarms:")
    print(pd.cut(sig, [0, 10, 50, 100, 500, 1000, 5000, np.inf]).value_counts().sort_index().to_string())
    print("\ndays to TCA of kept false alarms (vs all candidates):")
    lead = pd.cut(df["time_to_tca"], [0, 1, 2, 4, 7.01], right=False)
    tab = pd.DataFrame(
        {
            "false_alarms": pd.cut(k["time_to_tca"], [0, 1, 2, 4, 7.01], right=False).value_counts().sort_index(),
            "candidates": lead[df["cand"]].value_counts().sort_index(),
            "cand_truly_elevated": lead[df["cand"] & (df["risk"] >= RISK_ELEVATED)].value_counts().sort_index(),
        }
    )
    tab["fa_share_of_cand"] = (tab["false_alarms"] / tab["candidates"]).round(3)
    print(tab.to_string())
    print(
        f"\nkept false alarms with bound within 0.25 decade above 1e-6: {(k['max_risk_estimate'] < -5.75).sum():,}"
        f"; on the risk floor (-30): {(k['risk'] <= -29.99).sum():,}"
    )

    # Who is hard? Truly-Elevated candidates vs false-alarm candidates, medians
    cand = df[df["cand"]]
    pos = cand["risk"] >= RISK_ELEVATED
    cols = ["max_risk_estimate", "miss_distance", "c_sigma_r", "t_sigma_r", "time_to_tca", "p_elevated"]
    med = pd.DataFrame(
        {
            "truly Elevated": cand[pos][cols].median(),
            "FA kept": k[cols].median(),
            "FA demoted (correct)": cand[~pos & (cand["pred_tier"] == Tier.SAFE)][cols].median(),
        }
    )
    print("\nMedians among candidates:")
    print(med.round(4).to_string())

    # Under-tier anatomy
    ut = df[df["pred_tier"] < df["true_tier"]]
    print(
        f"\nUnder-tiered on train CV: {len(ut)} CDMs in {ut['event_id'].nunique()} events "
        f"(~{len(ut) * TEST_SCALE:.1f} test-equivalent; test actual 1)"
    )
    print("true risk of under-tiered:", np.round(np.sort(ut["risk"].to_numpy()), 2).tolist())
    print(
        "score/threshold of under-tiered:",
        np.round(np.sort((ut["p_elevated"] / ut["threshold"]).to_numpy()), 2).tolist(),
    )


def reliability(name, conf, correct, bins):
    out = pd.DataFrame({"conf": conf, "ok": correct})
    out["bin"] = pd.cut(out["conf"], bins, include_lowest=True)
    g = out.groupby("bin", observed=True).agg(n=("ok", "size"), mean_conf=("conf", "mean"), observed=("ok", "mean"))
    ece = float((g["n"] * (g["mean_conf"] - g["observed"]).abs()).sum() / g["n"].sum())
    print(f"\n{name}: ECE {ece:.3f}")
    print(g.round(3).to_string())
    return ece


def calibration(df):
    print("\n==== Calibration ====")
    correct = (df["pred_tier"] == df["true_tier"]).to_numpy()
    reliability(
        "confidence vs P(shown tier == true tier), all CDMs",
        df["confidence"],
        correct,
        [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
    )
    nc = ~df["cand"].to_numpy()
    reliability(
        "same, non-candidates only (rule tier, constant 0.5/0.8)",
        df["confidence"][nc],
        correct[nc],
        [0.5, 0.6, 0.79, 0.81, 0.99],
    )
    c = df[df["cand"]].copy()
    yc = (c["risk"] >= RISK_ELEVATED).to_numpy()
    reliability(
        "candidates: confidence vs correct",
        c["confidence"],
        (c["pred_tier"] == c["true_tier"]).to_numpy(),
        [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
    )
    reliability(
        "candidates: raw p_elevated vs truly Elevated (balanced class weights)",
        c["p_elevated"],
        yc,
        [0, 0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9, 1],
    )
    # cross-fitted isotonic: calibrate each outer fold with the other folds' OOF scores
    cal = np.zeros(len(c))
    for f in sorted(c["fold"].unique()):
        tr, va = (c["fold"] != f).to_numpy(), (c["fold"] == f).to_numpy()
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(c["p_elevated"][tr], yc[tr])
        cal[va] = iso.predict(c["p_elevated"][va])
    reliability(
        "candidates: isotonic-calibrated P(truly Elevated), cross-fitted",
        cal,
        yc,
        [0, 0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9, 1],
    )
    brier_raw = float(np.mean((c["p_elevated"] - yc) ** 2))
    brier_cal = float(np.mean((cal - yc) ** 2))
    print(
        f"\nBrier: raw {brier_raw:.4f}, calibrated {brier_cal:.4f}, base rate {yc.mean():.3f} "
        f"(constant-rate Brier {yc.mean() * (1 - yc.mean()):.4f})"
    )
    kept = (c["pred_tier"] == Tier.ELEVATED).to_numpy()
    print("Among KEPT candidates, calibrated P(truly Elevated) deciles -> observed rate:")
    q = pd.qcut(cal[kept], 5, duplicates="drop")
    print(
        pd.DataFrame({"p": cal[kept], "y": yc[kept]})
        .groupby(q, observed=True)["y"]
        .agg(["size", "mean"])
        .round(3)
        .to_string()
    )
    print(
        f"needs_review kept: observed truly-Elevated rate {yc[kept & c['needs_review'].to_numpy()].mean():.3f}; "
        f"not needs_review kept: {yc[kept & ~c['needs_review'].to_numpy()].mean():.3f}"
    )


def main():
    pd.set_option("display.width", 200)
    df = load_oof()
    false_alarm_anatomy(df)
    calibration(df)


if __name__ == "__main__":
    main()
