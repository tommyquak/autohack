"""Is `risk` worth using as a model input? Ablation on the 2-day-cutoff forecast task.

uv run --with lightgbm python -I docs/algorithm/risk_ablation.py <train_data.csv>

Labels always come from `risk` + miss distance (README tiers). The question is only whether `risk` from the
CDMs available at the cutoff (>= 2 days before TCA) may also be a model *input*. Same event filter and features as
baseline.py, vectorised; every config runs on identical folds, repeated over five fold seeds.

Decision rule (fixed before running): `risk` is worth using only if adding it improves Critical F2 or macro-F1 by
more than 0.01 AND by more than 2x the standard deviation of the paired difference across seeds.
"""

import sys

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, f1_score, fbeta_score, precision_score, recall_score
from sklearn.model_selection import StratifiedGroupKFold

COLS = [
    "event_id",
    "time_to_tca",
    "miss_distance",
    "relative_speed",
    "relative_position_r",
    "relative_position_t",
    "relative_position_n",
    "c_object_type",
    "c_sigma_r",
    "t_sigma_r",
    "max_risk_estimate",
    "F10",
    "AP",
    "risk",
]
SEEDS = [0, 1, 2, 3, 4]
MIN_GAIN = 0.01
# baseline.py's 23 features, in its order (used to check this port reproduces its LightGBM row)
BASELINE_23 = [
    "risk_last", "risk_max", "risk_mean", "risk_slope", "risk_delta", "md_last", "md_min", "md_slope", "n_cdm",
    "t_last", "speed", "pos_r", "pos_t", "pos_n", "c_sig_r", "t_sig_r", "c_sig_shrink", "max_risk_est", "F10", "AP",
    "debris", "payload", "tier_last",
]  # fmt: skip
RISK_FEATURES = ["risk_last", "risk_max", "risk_mean", "risk_slope", "risk_delta", "tier_last"]
# Allowed-column stand-ins: the same summaries built from max_risk_estimate (the Pc upper bound) instead of risk
ALLOWED_EXTRA = ["mre_max", "mre_mean", "mre_slope", "mre_delta", "tier_last_allowed", "miss_tier_last"]
ALLOWED = [c for c in BASELINE_23 if c not in RISK_FEATURES] + ALLOWED_EXTRA
ALLOWED_PLUS_RISK = ALLOWED + RISK_FEATURES


def tier(risk, miss):
    risk, miss = np.asarray(risk, float), np.asarray(miss, float)
    return np.where((risk >= -4) | (miss < 1000), 2, np.where((risk >= -6) | (miss <= 5000), 1, 0))


def load(path):
    df = pd.read_csv(path, usecols=COLS)
    t = df.groupby("event_id").time_to_tca
    ok = (t.max() >= 2) & (t.min() < 1)
    df = df[df.event_id.isin(ok[ok].index)].sort_values(["event_id", "time_to_tca"], ascending=[True, False])
    final = df.groupby("event_id").tail(1).set_index("event_id")  # true last row, no NaN skipping
    return df[df.time_to_tca >= 2], final


def slope(events, t, v):
    """Least-squares slope of v against -t per event, as np.polyfit(-t, v, 1)[0]; 0 for a single CDM."""
    x = -t
    d = pd.DataFrame({"e": events, "x": x, "v": v, "xx": x * x, "xv": x * v}).groupby("e")
    n, sx, sv, sxx, sxv = d.size(), d.x.sum(), d.v.sum(), d.xx.sum(), d.xv.sum()
    return ((n * sxv - sx * sv) / (n * sxx - sx**2)).where(n > 1, 0.0)


def log_sigma(s):
    return np.log10(s + 1e-9)


def features(inp):
    g = inp.groupby("event_id")
    last, first = g.tail(1).set_index("event_id"), g.head(1).set_index("event_id")
    e, t = inp.event_id.to_numpy(), inp.time_to_tca.to_numpy()
    X = pd.DataFrame(
        {
            "risk_last": last.risk,
            "risk_max": g.risk.max(),
            "risk_mean": g.risk.mean(),
            "risk_slope": slope(e, t, inp.risk.to_numpy()),
            "risk_delta": last.risk - first.risk,
            "md_last": last.miss_distance,
            "md_min": g.miss_distance.min(),
            "md_slope": slope(e, t, np.log10(inp.miss_distance.to_numpy())),
            "n_cdm": g.size(),
            "t_last": last.time_to_tca,
            "speed": last.relative_speed,
            "pos_r": last.relative_position_r,
            "pos_t": last.relative_position_t,
            "pos_n": last.relative_position_n,
            "c_sig_r": log_sigma(last.c_sigma_r),
            "t_sig_r": log_sigma(last.t_sigma_r),
            "c_sig_shrink": log_sigma(first.c_sigma_r) - log_sigma(last.c_sigma_r),
            "max_risk_est": last.max_risk_estimate,
            "F10": last.F10,
            "AP": last.AP,
            "debris": (last.c_object_type == "DEBRIS").astype(int),
            "payload": (last.c_object_type == "PAYLOAD").astype(int),
            "tier_last": pd.Series(tier(last.risk, last.miss_distance), index=last.index),
            "mre_max": g.max_risk_estimate.max(),
            "mre_mean": g.max_risk_estimate.mean(),
            "mre_slope": slope(e, t, inp.max_risk_estimate.to_numpy()),
            "mre_delta": last.max_risk_estimate - first.max_risk_estimate,
            "tier_last_allowed": pd.Series(tier(last.max_risk_estimate, last.miss_distance), index=last.index),
            "miss_tier_last": pd.Series(tier(np.full(len(last), -99.0), last.miss_distance), index=last.index),
        }
    )
    return X


def lgbm():
    return lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.03, num_leaves=31, class_weight="balanced", verbose=-1, random_state=0
    )


def hgb():
    return HistGradientBoostingClassifier(
        max_iter=400, learning_rate=0.03, max_leaf_nodes=31, class_weight="balanced", random_state=0
    )


def oof_proba(make, X, y, seed):
    oof = np.zeros((len(X), 3))
    folds = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=seed).split(X, y, groups=X.index)
    for tr, va in folds:
        oof[va] = make().fit(X.iloc[tr], y[tr]).predict_proba(X.iloc[va])
    return oof


def report(y, t0, pred, p_crit=None):
    crit, pc = y == 2, pred == 2
    esc = y > t0
    return {
        "acc": np.mean(pred == y),
        "macro_f1": f1_score(y, pred, average="macro"),
        "elev_f1": f1_score(y == 1, pred == 1),
        "crit_p": precision_score(crit, pc, zero_division=0),
        "crit_r": recall_score(crit, pc),
        "crit_f2": fbeta_score(crit, pc, beta=2),
        "crit_ap": average_precision_score(crit, p_crit) if p_crit is not None else np.nan,
        "esc_caught": int(np.sum(esc & (pred >= y))),
        "false_esc": int(np.sum((pred > t0) & (y <= t0))),
    }


def main():
    inp, final = load(sys.argv[1])
    X = features(inp).loc[final.index]
    y = tier(final.risk, final.miss_distance)
    t0 = X.tier_last.to_numpy()  # true tier at the cutoff: defines escalations (label side, may use risk)
    print(f"events {len(y)}  final tiers {np.bincount(y).tolist()}  escalations {(y > t0).sum()}")

    # Where does the Pc half of the rule decide the tier at all?
    pc_final, md_final = tier(final.risk, np.full(len(y), 1e9)), tier(np.full(len(y), -99.0), final.miss_distance)
    pc_cut = tier(X.risk_last, np.full(len(y), 1e9))
    md_cut = X.miss_tier_last.to_numpy()
    print(
        f"final tier set by Pc (Pc tier > miss tier): {np.sum(pc_final > md_final)} events "
        f"(final Elevated via Pc only: {np.sum((y == 1) & (md_final == 0))}, Critical via Pc only: "
        f"{np.sum((y == 2) & (md_final < 2))})"
    )
    print(
        f"cutoff tier set by Pc: {np.sum(pc_cut > md_cut)} events; of those, final tier still above miss tier: "
        f"{np.sum((pc_cut > md_cut) & (y > md_cut))}"
    )

    rows = []
    print("\n--- persistence baselines (no fitting) ---")
    for name, pred in [
        ("persist_risk (uses risk)", t0),
        ("persist_allowed (mre+miss)", X.tier_last_allowed.to_numpy()),
        ("persist_miss_only", md_cut),
    ]:
        r = report(y, t0, pred)
        print(f"{name:30s} " + " ".join(f"{k}={v:.3f}" if isinstance(v, float) else f"{k}={v}" for k, v in r.items()))

    check = report(y, t0, oof_proba(lgbm, X[BASELINE_23], y, 0).argmax(1))
    print(
        f"\nport check, baseline.py 23 features, LightGBM seed 0: acc={check['acc']:.3f} "
        f"crit_r={check['crit_r']:.3f} crit_f2={check['crit_f2']:.3f} esc={check['esc_caught']}/{(y > t0).sum()}"
    )

    for learner, make in [("lightgbm", lgbm), ("sklearn_hgb", hgb)]:
        for fs_name, cols in [("allowed", ALLOWED), ("allowed+risk", ALLOWED_PLUS_RISK)]:
            for seed in SEEDS:
                p = oof_proba(make, X[cols], y, seed)
                scores = report(y, t0, p.argmax(1), p[:, 2])
                rows.append({"learner": learner, "features": fs_name, "seed": seed, **scores})
    res = pd.DataFrame(rows)
    metrics = ["acc", "macro_f1", "elev_f1", "crit_p", "crit_r", "crit_f2", "crit_ap", "esc_caught", "false_esc"]
    print("\n--- models, mean (sd) over 5 fold seeds ---")
    summary = res.groupby(["learner", "features"])[metrics].agg(["mean", "std"])
    for (learner, fs_name), r in summary.iterrows():
        cells = " ".join(f"{m}={r[(m, 'mean')]:.3f}({r[(m, 'std')]:.3f})" for m in metrics)
        print(f"{learner:12s} {fs_name:13s} {cells}")

    print("\n--- paired difference (allowed+risk minus allowed), mean (sd) over seeds ---")
    worth = False
    for learner in ["lightgbm", "sklearn_hgb"]:
        a = res[(res.learner == learner) & (res.features == "allowed")].set_index("seed")[metrics]
        b = res[(res.learner == learner) & (res.features == "allowed+risk")].set_index("seed")[metrics]
        d = b - a
        print(f"{learner:12s} " + " ".join(f"{m}={d[m].mean():+.3f}({d[m].std():.3f})" for m in metrics))
        for m in ["crit_f2", "macro_f1"]:
            gain, sd = d[m].mean(), d[m].std()
            worth |= gain > MIN_GAIN and gain > 2 * sd
    print(f"\nDECISION: risk as input is {'WORTH IT' if worth else 'NOT worth it'} under the pre-set rule")


if __name__ == "__main__":
    main()
