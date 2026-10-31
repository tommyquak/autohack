"""Can we SAFELY tell the analyst "this Critical is Pc-only and likely over-warned" without changing the tier?

    uv run python scripts/review_critical_flag.py

Population: CDMs that are Critical only because the Pc upper bound is >= 1e-4 (miss >= 1 km), usable
covariance. These are the test set's 165 + 8 over-tiered Criticals. The tier stays Critical whatever this
says; the flag is decision support. A wrong flag (a truly-Critical CDM labelled "likely over-warned") is the
costly error, so we report it as "truly Critical flagged" next to precision.

Method: HistGradientBoosting P(true Pc >= 1e-4) on the triage feature set (allowed columns only), nested
event-grouped CV on TRAIN: in each outer fold the flag threshold is the q-quantile of the inner-OOF scores
of truly-Critical rows (at most q of truly-Critical rows flagged, split-conformal style), then scored on the
held-out events. Simple deterministic rules are scored the same way for comparison. Test is never read.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402

from triage.data import EVENT, RAW_DIR, find_csv, load_cdms  # noqa: E402
from triage.features import build_features, dilution_flag  # noqa: E402
from triage.tiers import RISK_CRITICAL, Tier  # noqa: E402

MONO = {"max_risk_estimate": 1, "margin_critical": 1, "margin_elevated": 1, "max_risk_so_far": 1}


def model(cols):
    return HistGradientBoostingClassifier(
        max_iter=200,
        learning_rate=0.05,
        max_leaf_nodes=15,
        min_samples_leaf=20,
        l2_regularization=1.0,
        categorical_features=["c_object_type"],
        monotonic_cst={k: v for k, v in MONO.items() if k in cols},
        random_state=0,
    )


def oof_scores(X, y, groups, n=5):
    s = np.zeros(len(y))
    for tr, va in GroupKFold(n).split(X, y, groups):
        s[va] = model(X.columns).fit(X.iloc[tr], y[tr]).predict_proba(X.iloc[va])[:, 1]
    return s


def report(name, flag, over, events):
    crit = ~over
    n = int(flag.sum())
    prec = float(over[flag].mean()) if n else float("nan")
    return {
        "flag": name,
        "flagged": n,
        "precision_over_warned": round(prec, 4),
        "recall_of_over_warned": round(float(flag[over].mean()), 3),
        "truly_critical_flagged": int((flag & crit).sum()),
        "events_with_wrong_flag": int(events[flag & crit].nunique()),
    }


def main():
    pd.set_option("display.width", 200)
    df = load_cdms(find_csv("train", RAW_DIR))
    X_all = build_features(df)
    pop = ((df["max_risk_estimate"] >= RISK_CRITICAL) & (df["miss_distance"] >= 1000) & ~dilution_flag(df)).to_numpy()
    sub = df[pop].reset_index(drop=True)
    X = X_all[pop].reset_index(drop=True)
    over = (sub["true_tier"] < Tier.CRITICAL).to_numpy()  # truly not Critical -> over-warned
    y = ~over  # model target: truly Critical
    g = sub[EVENT].to_numpy()
    print(
        f"Pc-only Critical CDMs (train): {len(sub):,} in {sub[EVENT].nunique()} events; "
        f"over-warned {over.sum():,} ({over.mean():.1%}), truly Critical {y.sum():,}"
    )
    print(
        "their true tiers:",
        sub["true_tier"].value_counts().sort_index().to_dict(),
        "| miss > 5 km:",
        int((sub["miss_distance"] > 5000).sum()),
    )

    rows = [report("all Pc-only Criticals (no model)", np.ones(len(sub), bool), over, sub[EVENT])]
    # Simple deterministic rules
    rows.append(report("rule: miss > 5 km", (sub["miss_distance"] > 5000).to_numpy(), over, sub[EVENT]))
    rows.append(report("rule: bound < 1e-3.5", (sub["max_risk_estimate"] < -3.5).to_numpy(), over, sub[EVENT]))
    rows.append(
        report(
            "rule: miss > 5 km and bound < 1e-3.5",
            ((sub["miss_distance"] > 5000) & (sub["max_risk_estimate"] < -3.5)).to_numpy(),
            over,
            sub[EVENT],
        )
    )

    # Nested CV model flag
    outer = list(GroupKFold(5).split(X, y, g))
    s_out = np.zeros(len(sub))
    thr = {q: np.zeros(len(sub)) for q in [0.0, 0.01, 0.02, 0.05, 0.10]}
    for tr, va in outer:
        inner = oof_scores(X.iloc[tr].reset_index(drop=True), y[tr], g[tr])
        s_out[va] = model(X.columns).fit(X.iloc[tr], y[tr]).predict_proba(X.iloc[va])[:, 1]
        for q in thr:
            pos = inner[y[tr]]
            thr[q][va] = (pos.min() - 1e-12) if q == 0 else np.quantile(pos, q)
    for q, t in thr.items():
        rows.append(report(f"model: P(crit) < q{q:g} of true-Crit scores", s_out < t, over, sub[EVENT]))
    print("\nNested event-grouped CV on train (flag never changes the tier):")
    print(pd.DataFrame(rows).to_string(index=False))

    # What are the truly-Critical rows that look over-warned?
    print("\nTop over-warned likelihood bins (pooled OOF score), observed over-warned share:")
    b = pd.cut(s_out, [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0], include_lowest=True)
    print(pd.DataFrame({"over": over}).groupby(b, observed=True)["over"].agg(["size", "mean"]).round(3).to_string())


if __name__ == "__main__":
    main()
