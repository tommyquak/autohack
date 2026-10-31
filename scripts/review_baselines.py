"""Are we comparing against the right baselines? Untuned rules on TEST, tuned rules on TRAIN CV only.

    uv run python scripts/review_baselines.py

Part A (test set): fixed, untuned rules. Nothing here is fitted or chosen by looking at test - each rule
is written down from the brief's thresholds before it is scored - so scoring them on test is a baseline,
not tuning.
Part B (train, event-grouped 5-fold CV, same outer folds as review_oof.py): simple rules that *are* tuned
(a shifted Pc-bound threshold, a per-miss-bin threshold), chosen on the training folds with the SAME
split-conformal rule the model uses (keep >= 99% of truly-Elevated candidates) and scored on the held-out
fold. Compared with the cached v1 out-of-fold predictions. Never scored on test.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from triage.data import RAW_DIR, find_csv, group_folds, load_cdms  # noqa: E402
from triage.tiers import RISK_CRITICAL, RISK_ELEVATED, Tier, miss_tier, pc_tier  # noqa: E402
from triage.train import candidates  # noqa: E402


def score(name, y, pred):
    crit = y == Tier.CRITICAL
    return {
        "method": name,
        "crit_recall": round(float((pred[crit] == Tier.CRITICAL).mean()), 4),
        "crit_missed": int((crit & (pred < Tier.CRITICAL)).sum()),
        "false_alarms": int(((y == Tier.SAFE) & (pred >= Tier.ELEVATED)).sum()),
        "flagged_pct": round(100 * float((pred >= Tier.ELEVATED).mean()), 1),
        "under_tier": int((pred < y).sum()),
        "over_tier": int((pred > y).sum()),
    }


def untuned_rules(df):
    b, m = df["max_risk_estimate"].to_numpy(), df["miss_distance"].to_numpy()
    mt, bt = miss_tier(m), pc_tier(b)
    crit_only = np.where(b >= RISK_CRITICAL, Tier.CRITICAL, Tier.SAFE)
    return {
        "Always below threshold": np.zeros(len(df), int),
        "Miss-distance rule (official 1/5 km)": mt,
        "Pc bound rule (status quo)": np.maximum(bt, mt),
        "Pc bound OR miss<1 km (drops 1-5 km Elevated)": np.maximum(bt, np.where(m < 1000, Tier.CRITICAL, Tier.SAFE)),
        "Miss rule + Pc bound for Critical only": np.maximum(mt, crit_only),
        "Pc bound with Elevated band at 1e-5 (round number)": np.maximum(
            mt, np.where(b >= RISK_CRITICAL, 2, np.where(b >= -5.0, 1, 0))
        ),
    }


def sanity(df, split):
    b, r, m = df["max_risk_estimate"], df["risk"], df["miss_distance"]
    print(f"\n[{split}] is max_risk_estimate an upper bound? risk > bound in {int((r > b + 1e-9).sum()):,} CDMs")
    pc_crit_true = r >= RISK_CRITICAL
    print(
        f"[{split}] truly Pc-Critical: {int(pc_crit_true.sum()):,}; of those bound < -4: "
        f"{int((pc_crit_true & (b < RISK_CRITICAL)).sum())}"
    )
    pc_el_true = (r >= RISK_ELEVATED) & (m > 5000)
    print(
        f"[{split}] truly Pc-Elevated with miss>5km: {int(pc_el_true.sum()):,}; of those bound < -6: "
        f"{int((pc_el_true & (b < RISK_ELEVATED)).sum())}"
    )


def tuned_cv(df, oof_pred):
    """Tuned simple rules, event-grouped CV on train. Threshold chosen on training folds only."""
    y = df["true_tier"].to_numpy()
    b, m = df["max_risk_estimate"].to_numpy(), df["miss_distance"].to_numpy()
    base = np.maximum(pc_tier(b), miss_tier(m))
    cand = candidates(df)
    pos = df["risk"].to_numpy() >= RISK_ELEVATED
    logm = np.log10(np.clip(m, 1, None))
    bins = np.quantile(logm[cand], np.linspace(0, 1, 11))
    mbin = np.clip(np.searchsorted(bins, logm, side="right") - 1, 0, 9)
    shift = base.copy()
    binned = base.copy()
    thr_shift = []
    for tr, _va in group_folds(df, 5):
        trm = np.zeros(len(df), bool)
        trm[tr] = True
        vam = ~trm
        # 1-parameter rule: demote a candidate when its Pc bound is below t (t keeps 99% of true-Elevated)
        t = np.quantile(b[trm & cand & pos], 0.01)
        thr_shift.append(round(float(t), 3))
        shift[vam & cand & (b < t)] = Tier.SAFE
        # 10-parameter rule: same, one threshold per miss-distance decile
        for k in range(10):
            sel = trm & cand & pos & (mbin == k)
            tk = np.quantile(b[sel], 0.01) if sel.sum() >= 20 else RISK_ELEVATED
            binned[vam & cand & (mbin == k) & (b < tk)] = Tier.SAFE
    print(f"\nshifted-bound thresholds per fold (log10 Pc bound): {thr_shift}")
    rows = [
        score("Pc bound rule (status quo)", y, base),
        score("Tuned: Pc bound shifted (1 param, 99% rule)", y, shift),
        score("Tuned: Pc bound per miss decile (10 params, 99% rule)", y, binned),
        score("Second Look v1 (nested CV OOF)", y, oof_pred),
    ]
    # Miss-only rules with a tuned Elevated distance (flag Elevated if miss <= D): how far must D go
    # to keep >= 99% of truly-Elevated-by-Pc candidates? (Answers "what about a tuned miss threshold?")
    for d_km in [5, 10, 20, 50]:
        pred = np.maximum(miss_tier(m), np.where(b >= RISK_CRITICAL, 2, np.where(m <= d_km * 1000, 1, 0)))
        rows.append(score(f"Miss <= {d_km} km Elevated + Pc bound Critical", y, pred))
    return pd.DataFrame(rows)


def main():
    pd.set_option("display.width", 200)
    from review_oof import load_oof

    test = load_cdms(find_csv("test", RAW_DIR))
    train = load_oof()
    for d, s in [(train, "train"), (test, "test")]:
        sanity(d, s)

    print("\n== Part A: untuned rules on TEST (24,484 CDMs; fixed rules, nothing fitted) ==")
    y = test["true_tier"].to_numpy()
    print(pd.DataFrame([score(k, y, v) for k, v in untuned_rules(test).items()]).to_string(index=False))

    print("\n== Part A': same untuned rules on TRAIN (for scale) ==")
    yt = train["true_tier"].to_numpy()
    print(pd.DataFrame([score(k, yt, v) for k, v in untuned_rules(train).items()]).to_string(index=False))

    print("\n== Part B: tuned simple rules vs v1, TRAIN event-grouped CV (never test) ==")
    print(tuned_cv(train, train["pred_tier"].to_numpy()).to_string(index=False))


if __name__ == "__main__":
    main()
