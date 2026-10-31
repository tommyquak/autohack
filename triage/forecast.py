"""Official task: forecast each event's FINAL tier from its messages >= 2 days before TCA, with a bounded decision.

    uv run python -m triage.forecast        # ~10 min the first time (refits the nowcast per fold), then cached

Model: two class-weighted HistGradientBoosting classifiers with monotonic constraints, P(final >= Elevated) and
P(final >= Critical) (cumulative ordinal model; scikit-learn has no monotonic constraints for multiclass). Together
they give P(final tier) = [below threshold, Elevated, Critical].

Bounded decision layer (every event gets a decision record):
- floor = Critical if the latest >= 2-day message is Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km):
  never downgraded. Otherwise the miss-distance tier, raised to the team nowcast's tier at that message: an event that
  is Elevated only because of the Pc upper bound stays Elevated unless the existing constrained demoter
  (triage.model, 99% recall target on truly-Elevated messages) removes it.
- the model may only ESCALATE: to Critical when P(final Critical) >= t_crit, to Elevated when
  P(final >= Elevated) >= t_elev. predicted_final = max(floor, escalation).
- t_crit: the loosest threshold that reaches the final-Critical recall target on out-of-fold scores of the training
  portion only. t_elev: maximises F2 of "final >= Elevated" on the same out-of-fold scores.

Protocol (organisers first): one seeded 80/20 event split stratified by final tier, then 5-fold event CV. One row per
event, so no event is ever split. The nowcast is refit inside every split without the held-out events (its training
events get inner cross-fitted nowcast tiers). Thresholds are chosen inside the training portion (nested). test_data
has no final outcomes: it gets demo predictions only, never a score.

Writes data/demo/forecast_metrics.json, reports/forecast_metrics.json, predictions/test_final_tier.csv and a
`forecast` object per event in data/demo/events.json (existing fields unchanged, asserted).
"""

import argparse
import contextlib
import io
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import confusion_matrix, f1_score, fbeta_score
from sklearn.model_selection import KFold, StratifiedKFold, train_test_split

from triage import model as nowcast_model
from triage.data import EVENT, LABEL, RAW_DIR, find_csv, load_cdms
from triage.forecast_features import (
    CUTOFF_DAYS,
    MONOTONIC,
    cutoff_inputs,
    event_features,
    final_messages,
    label_agreement,
    load_labels,
)
from triage.tiers import MISS_CRITICAL_M, MISS_ELEVATED_M, RISK_CRITICAL, TIER_NAMES, Tier, true_tier

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
DEMO = ROOT / "data" / "demo"
CACHE = REPORTS / "forecast_cache"
PREDICTIONS = ROOT / "predictions" / "test_final_tier.csv"
CRITICAL_RECALL_TARGET = 0.95
SENSITIVITY_TARGETS = (0.85, 0.90, 0.95)
N_FOLDS = 5
SEED = 0
NAMES = [TIER_NAMES[t] for t in Tier]


# ---------- nowcast at the latest >= 2-day message ----------


def nowcast_table(artifact: dict | None, inputs: pd.DataFrame) -> pd.DataFrame:
    """The team nowcast (triage.model) at each event's latest >= 2-day message: tier and demotion score."""
    tiers = nowcast_model.predict(inputs, artifact)["pred_tier"]
    p = nowcast_model.predict_with(artifact, inputs)["p_elevated"] if artifact else pd.Series(np.nan, inputs.index)
    t = pd.DataFrame({EVENT: inputs[EVENT], "tca": inputs["time_to_tca"], "nowcast_tier": tiers, "p": p})
    last = t.loc[t.groupby(EVENT)["tca"].idxmin()].set_index(EVENT)
    return last[["nowcast_tier"]].assign(nowcast_p_elevated=last["p"])


def _fit_nowcast(df_all: pd.DataFrame, exclude) -> dict:
    from triage.train import train

    with contextlib.redirect_stdout(io.StringIO()):
        return train(df_all[~df_all[EVENT].isin(exclude)].reset_index(drop=True))


def crossfit_nowcast(df_all, inputs, train_ids, val_ids, key: str, inner: int = 3) -> pd.DataFrame:
    """Nowcast tiers for val (model fit without val events) and for train (inner folds, also without val events)."""
    path = CACHE / f"nowcast_{key}.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    val_ids, train_ids = np.asarray(val_ids), np.asarray(train_ids)
    parts = [nowcast_table(_fit_nowcast(df_all, set(val_ids)), inputs[inputs[EVENT].isin(val_ids)])]
    for _, j in KFold(inner, shuffle=True, random_state=SEED).split(train_ids):
        held = train_ids[j]
        art = _fit_nowcast(df_all, set(val_ids) | set(held))
        parts.append(nowcast_table(art, inputs[inputs[EVENT].isin(held)]))
    out = pd.concat(parts).sort_index()
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(out))
    return out


# ---------- model ----------


def _hgb(columns) -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        max_iter=300,
        learning_rate=0.05,
        max_leaf_nodes=15,
        min_samples_leaf=40,
        l2_regularization=1.0,
        categorical_features=[c == "object_type" for c in columns],
        monotonic_cst=[MONOTONIC.get(c, 0) for c in columns],
        class_weight="balanced",
        random_state=SEED,
    )


class Forecaster:
    """Cumulative ordinal model: P(final >= Elevated) and P(final >= Critical), each monotonic and class-weighted."""

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> "Forecaster":
        self.columns = list(X.columns)
        self.ge = {k: _hgb(self.columns).fit(X, (y >= k).astype(int)) for k in (Tier.ELEVATED, Tier.CRITICAL)}
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        X = X[self.columns]
        ge_e = self.ge[Tier.ELEVATED].predict_proba(X)[:, 1]
        ge_c = np.minimum(self.ge[Tier.CRITICAL].predict_proba(X)[:, 1], ge_e)
        return np.column_stack([1 - ge_e, ge_e - ge_c, ge_c])


# ---------- bounded decision layer ----------


def floor_tier(f: pd.DataFrame, variant: str = "nowcast") -> np.ndarray:
    """Rule floor. 'nowcast' (shipped): Critical by rule, else max(miss tier, nowcast tier).
    'rule': the max_risk_estimate + miss rule tier as is (Pc-only Elevated never lowered)."""
    crit = f["rule_tier"].to_numpy() == Tier.CRITICAL
    if variant == "rule" or "nowcast_tier" not in f:
        base = f["rule_tier"].to_numpy()
    else:
        nc = f["nowcast_tier"].fillna(f["rule_tier"]).to_numpy()
        base = np.maximum(f["miss_tier"].to_numpy(), nc)
    return np.where(crit, Tier.CRITICAL, base).astype(int)


def decide(floor: np.ndarray, p: np.ndarray, t_elev: float, t_crit: float) -> np.ndarray:
    """predicted_final = max(floor, escalation). The model never lowers the floor."""
    esc = np.where(p[:, 2] >= t_crit, Tier.CRITICAL, np.where(p[:, 1] + p[:, 2] >= t_elev, Tier.ELEVATED, Tier.SAFE))
    return np.maximum(floor, esc).astype(int)


def choose_thresholds(y, p, floor, target: float = CRITICAL_RECALL_TARGET) -> dict:
    """Thresholds from out-of-fold scores of TRAINING events only."""
    crit = y == Tier.CRITICAL
    need = int(np.ceil(target * crit.sum())) - int((crit & (floor == Tier.CRITICAL)).sum())
    pool = np.sort(p[crit & (floor < Tier.CRITICAL), 2])[::-1]
    t_crit = 1.0 if need <= 0 or not len(pool) else float(pool[min(need, len(pool)) - 1])
    ge_e = p[:, 1] + p[:, 2]
    best, t_elev = -1.0, 1.0
    for t in np.unique(np.quantile(ge_e, np.linspace(0.5, 0.999, 200))):
        pred = decide(floor, p, t, t_crit)
        s = fbeta_score(y >= Tier.ELEVATED, pred >= Tier.ELEVATED, beta=2, zero_division=0)
        if s > best:
            best, t_elev = s, float(t)
    return {"t_elev": t_elev, "t_crit": t_crit, "critical_recall_target": target}


# ---------- metrics ----------


def score(y: np.ndarray, pred: np.ndarray, cut: np.ndarray) -> dict:
    """y = final tier, cut = true tier (risk + miss) at the latest >= 2-day message (labels only, for escalations)."""
    crit, pcrit = y == Tier.CRITICAL, pred == Tier.CRITICAL
    tp = int((crit & pcrit).sum())
    prec = tp / pcrit.sum() if pcrit.any() else 0.0
    rec = tp / crit.sum() if crit.any() else 0.0
    esc = y > cut
    return {
        "n": int(len(y)),
        "accuracy": float((y == pred).mean()),
        "macro_f1": float(f1_score(y, pred, labels=list(Tier), average="macro", zero_division=0)),
        "critical_recall": float(rec),
        "critical_precision": float(prec),
        "critical_f2": float(5 * prec * rec / (4 * prec + rec)) if prec + rec else 0.0,
        "escalations": int(esc.sum()),
        "escalations_caught": int((esc & (pred >= y)).sum()),
        "false_escalations": int(((pred > cut) & (y <= cut)).sum()),
        "under_tier": int((pred < y).sum()),
        "confusion": confusion_matrix(y, pred, labels=list(Tier)).tolist(),
    }


METHODS = {
    "always_below_threshold": "Always below threshold",
    "persistence_miss": "Persistence: miss-distance tier at latest >=2 d message",
    "persistence_rule": "Persistence: max_risk_estimate + miss rule tier",
    "persistence_nowcast": "Persistence: team nowcast tier (dashboard tier)",
    "reference_persistence_risk": "REFERENCE ONLY: risk + miss tier at latest >=2 d (uses the label column)",
    "model_argmax_unbounded": "Ablation: model argmax, no floor (not shipped)",
    "bounded_rule_floor": "Ablation: bounded, Pc-only Elevated left as is",
    "second_look_forecast": "Second Look forecast (bounded: floor + model escalation)",
}


def run_split(df_all, inputs, labels, cut_true, train_ids, val_ids, key) -> dict:
    """Fit on train_ids, choose thresholds on train-only OOF scores, score val_ids. Returns results + val outputs."""
    nc = crossfit_nowcast(df_all, inputs, train_ids, val_ids, key)
    feats = event_features(inputs[inputs[EVENT].isin(np.r_[train_ids, val_ids])], nc)
    y_all = labels["final_tier"]
    Xtr, ytr = feats.loc[train_ids], y_all.loc[train_ids].to_numpy()
    Xva, yva = feats.loc[val_ids], y_all.loc[val_ids].to_numpy()
    oof = np.zeros((len(Xtr), 3))
    for a, b in StratifiedKFold(N_FOLDS, shuffle=True, random_state=SEED + 1).split(Xtr, ytr):
        oof[b] = Forecaster().fit(Xtr.iloc[a], ytr[a]).predict_proba(Xtr.iloc[b])
    th = choose_thresholds(ytr, oof, floor_tier(Xtr))
    th_rule = choose_thresholds(ytr, oof, floor_tier(Xtr, "rule"))
    p = Forecaster().fit(Xtr, ytr).predict_proba(Xva)
    cut = cut_true.loc[val_ids].to_numpy()
    preds = {
        "always_below_threshold": np.zeros(len(yva), int),
        "persistence_miss": Xva["miss_tier"].to_numpy(),
        "persistence_rule": Xva["rule_tier"].to_numpy(),
        "persistence_nowcast": Xva["nowcast_tier"].to_numpy().astype(int),
        "reference_persistence_risk": cut,
        "model_argmax_unbounded": p.argmax(1),
        "bounded_rule_floor": decide(floor_tier(Xva, "rule"), p, th_rule["t_elev"], th_rule["t_crit"]),
        "second_look_forecast": decide(floor_tier(Xva), p, th["t_elev"], th["t_crit"]),
    }
    return {
        "n_train": int(len(train_ids)),
        "n_val": int(len(val_ids)),
        "thresholds": th,
        "thresholds_rule_floor": th_rule,
        "results": {m: score(yva, preds[m], cut) for m in METHODS},
        # Cost of the recall target: the shipped layer re-tuned (train-only) for looser Critical recall targets.
        "recall_target_sensitivity": {
            str(tg): score(yva, decide(floor_tier(Xva), p, t["t_elev"], t["t_crit"]), cut)
            for tg in SENSITIVITY_TARGETS
            for t in [choose_thresholds(ytr, oof, floor_tier(Xtr), tg)]
        },
        "_val": pd.DataFrame({"p0": p[:, 0], "p1": p[:, 1], "p2": p[:, 2], "y": yva, "cut": cut}, index=val_ids).assign(
            **{f"pred_{m}": v for m, v in preds.items()}
        ),
        "_nc": nc.loc[val_ids],
    }


def summarise(folds: list[dict]) -> dict:
    return summarise_methods(folds, list(METHODS))


def summarise_methods(folds: list[dict], methods: list[str]) -> dict:
    """Per method and metric: mean, sd and sum over folds (confusion matrices summed)."""
    out = {}
    for m in methods:
        out[m] = {}
        for k in folds[0][m]:
            if k == "confusion":
                out[m][k] = np.sum([f[m][k] for f in folds], axis=0).tolist()
                continue
            v = np.array([f[m][k] for f in folds], float)
            out[m][k] = {"mean": float(v.mean()), "sd": float(v.std(ddof=1)), "sum": float(v.sum())}
    return out


# ---------- decision records ----------


def _km(m: float) -> str:
    return f"{m:.0f} m" if m < 10_000 else f"{m / 1000:,.1f} km"


def floor_reason(r: pd.Series, floor: int) -> str:
    when = f"at the latest update 2+ days out ({r['tca_latest']:.1f} d)"
    if floor == Tier.CRITICAL:
        why = []
        if r["miss_latest"] < MISS_CRITICAL_M:
            why.append(f"miss distance {_km(r['miss_latest'])} is under 1 km")
        if r["mre_latest"] >= RISK_CRITICAL:
            why.append(f"Pc upper bound 1e{r['mre_latest']:.1f} is at or above 1e-4")
        return f"Critical by rule {when}: {' and '.join(why) or 'input could not be trusted'}; never lowered"
    if floor == Tier.ELEVATED:
        if r["miss_tier"] == Tier.ELEVATED:
            return f"Elevated floor {when}: miss distance {_km(r['miss_latest'])} is within 1-5 km"
        return (
            f"Elevated floor {when}: Pc upper bound 1e{r['mre_latest']:.1f} is in the Elevated band and the "
            "constrained demoter kept it"
        )
    if r["pc_bound_tier"] >= Tier.ELEVATED:
        return (
            f"Below-threshold floor {when}: miss distance {_km(r['miss_latest'])} is over 5 km and the constrained "
            f"demoter judged the Pc upper bound (1e{r['mre_latest']:.1f}) an over-warning"
        )
    return (
        f"Below-threshold floor {when}: Pc upper bound under 1e-6 and miss distance {_km(r['miss_latest'])} over 5 km"
    )


def driver_reasons(r: pd.Series) -> list[str]:
    out = []
    first = 10 ** (r["log_miss_latest"] - r["log_miss_change"])
    if r["log_miss_change"] < -0.1:
        out.append(
            f"Closing: miss distance fell from {_km(first)} to {_km(r['miss_latest'])} over {int(r['n_cdm'])} updates"
        )
    nxt = MISS_CRITICAL_M if r["miss_latest"] <= MISS_ELEVATED_M else MISS_ELEVATED_M
    if nxt < r["miss_latest"] < 1.5 * nxt:
        out.append(f"Miss distance {_km(r['miss_latest'])} is within 1.5x of the {_km(nxt)} line")
    if r["log_miss_min"] < r["log_miss_latest"] - 0.1:
        out.append(f"An earlier update put the miss distance at {_km(10 ** r['log_miss_min'])}")
    if r["mre_max"] > r["mre_latest"] + 0.5 or (r["mre_slope"] > 0.2 and r["n_cdm"] > 1):
        out.append(f"Pc upper bound peaked at 1e{r['mre_max']:.1f} (latest 1e{r['mre_latest']:.1f})")
    if r["sigma_placeholder"] or r["log_sigma_c_latest"] > 2.5:
        out.append("Position uncertainty is still large, so later updates may move the miss distance")
    if r["n_cdm"] <= 2:
        out.append(f"Only {int(r['n_cdm'])} update(s) 2+ days out: little history to judge a trend")
    if not out:
        out.append(f"Miss distance steady over {int(r['n_cdm'])} updates")
    return out


def decision_records(feats: pd.DataFrame, p: np.ndarray, th: dict) -> pd.DataFrame:
    floor = floor_tier(feats)
    pred = decide(floor, p, th["t_elev"], th["t_crit"])
    rows = []
    for i, (eid, r) in enumerate(feats.iterrows()):
        fr = floor_reason(r, int(floor[i]))
        if pred[i] > floor[i]:
            t = th["t_crit"] if pred[i] == Tier.CRITICAL else th["t_elev"]
            pk = p[i, 2] if pred[i] == Tier.CRITICAL else p[i, 1] + p[i, 2]
            what = "Critical" if pred[i] == Tier.CRITICAL else "Elevated or Critical"
            lead = (
                f"Forecast escalates to {NAMES[pred[i]]}: model score for a final tier of {what} is {pk:.2f}, "
                f"at or above the threshold {t:.2f} (set for a {th['critical_recall_target']:.0%} final-Critical "
                "recall target)"
            )
            decision = f"escalated to {NAMES[pred[i]]}"
            reasons = [lead, *driver_reasons(r)[:1], fr]
        else:
            decision = "floor kept"
            reasons = [fr, *driver_reasons(r)[:2]]
        rows.append(
            {
                EVENT: int(eid),
                "predicted_final_tier": int(pred[i]),
                "predicted_final_tier_name": NAMES[pred[i]],
                "p_below_threshold": float(p[i, 0]),
                "p_elevated": float(p[i, 1]),
                "p_critical": float(p[i, 2]),
                "floor_tier": int(floor[i]),
                "floor_tier_name": NAMES[floor[i]],
                "decision": decision,
                "reasons": reasons[:3],
            }
        )
    return pd.DataFrame(rows).set_index(EVENT)


# ---------- events.json ----------


def add_to_events(path: Path, records: pd.DataFrame, th: dict) -> dict:
    """Add a `forecast` object to every event; every existing field is asserted unchanged."""
    data = json.loads(path.read_text())
    before = json.dumps({**data, "events": [{k: v for k, v in e.items() if k != "forecast"} for e in data["events"]]})
    for e in data["events"]:
        r = records.loc[e["event_id"]]
        e["forecast"] = {
            "predicted_final_tier": int(r["predicted_final_tier"]),
            "predicted_final_tier_name": r["predicted_final_tier_name"],
            "p_final": [round(float(r[c]), 4) for c in ("p_below_threshold", "p_elevated", "p_critical")],
            "floor_tier": int(r["floor_tier"]),
            "decision": r["decision"],
            "thresholds": {"t_elev": round(th["t_elev"], 4), "t_crit": round(th["t_crit"], 4)},
            "reasons": list(r["reasons"]),
        }
    after = json.dumps({**data, "events": [{k: v for k, v in e.items() if k != "forecast"} for e in data["events"]]})
    assert before == after, "adding the forecast changed an existing events.json field"
    for e in data["events"]:
        assert e["forecast"]["predicted_final_tier"] >= e["forecast"]["floor_tier"]
        if e["tier"] == Tier.CRITICAL:
            assert e["forecast"]["predicted_final_tier"] == Tier.CRITICAL
    path.write_text(json.dumps(data, separators=(",", ":")))  # same compact form as the frozen file
    return data


# ---------- main ----------


def _table(results: dict, sd: dict | None = None) -> str:
    keys = ["accuracy", "macro_f1", "critical_recall", "critical_precision", "critical_f2"]
    lines = []
    for m in METHODS:
        r = results[m]
        if sd is None:
            vals = [f"{r[k]:.3f}" for k in keys] + [f"{r['escalations_caught']}/{r['escalations']}"]
            vals.append(str(r["false_escalations"]))
        else:
            vals = [f"{sd[m][k]['mean']:.3f}±{sd[m][k]['sd']:.3f}" for k in keys]
            vals.append(f"{int(sd[m]['escalations_caught']['sum'])}/{int(sd[m]['escalations']['sum'])}")
            vals.append(str(int(sd[m]["false_escalations"]["sum"])))
        lines.append(f"{m:28s} " + " ".join(f"{v:>14s}" for v in vals))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", help="organisers' xlsx (default data/raw/labels/challenge1_event_labels.xlsx)")
    ap.add_argument("--no-events", action="store_true", help="do not touch data/demo/events.json")
    args = ap.parse_args()
    df = load_cdms(find_csv("train", RAW_DIR))
    labels = load_labels(args.labels) if args.labels else load_labels()
    agreement = label_agreement(labels, df)
    print("label agreement:", {k: v for k, v in agreement.items() if "confusion" not in k})

    ids = labels.index[labels["usable"]].to_numpy()  # organisers' cohort: >= 1 message 2+ days out
    inputs = cutoff_inputs(df[df[EVENT].isin(ids)])
    cut_msgs = df[df["time_to_tca"] >= CUTOFF_DAYS]
    cut_msgs = cut_msgs.loc[cut_msgs.groupby(EVENT)["time_to_tca"].idxmin()].set_index(EVENT)
    cut_true = pd.Series(true_tier(cut_msgs[LABEL], cut_msgs["miss_distance"]), index=cut_msgs.index)
    y = labels.loc[ids, "final_tier"].to_numpy()
    final_tca = final_messages(df)["time_to_tca"]

    # 1. Organisers' protocol: one seeded 80/20 split, stratified by final tier.
    tr, va = train_test_split(ids, test_size=0.2, stratify=y, random_state=SEED)
    split = run_split(df, inputs, labels, cut_true, tr, va, "8020")
    print(f"\n80/20 (val n={len(va)}) thresholds {split['thresholds']}")
    print(_table(split["results"]))

    # 2. 5-fold event CV for stability.
    folds, oof = [], []
    for k, (a, b) in enumerate(StratifiedKFold(N_FOLDS, shuffle=True, random_state=SEED).split(ids, y)):
        print(f"CV fold {k + 1}/{N_FOLDS}")
        folds.append(run_split(df, inputs, labels, cut_true, ids[a], ids[b], f"cv{k}"))
        oof.append(folds[-1]["_val"].assign(fold=k))
    cv = summarise([f["results"] for f in folds])
    sens = {}
    for tg in SENSITIVITY_TARGETS:
        per = [{"second_look_forecast": f["recall_target_sensitivity"][str(tg)]} for f in folds]
        s = {k: v for k, v in summarise_methods(per, ["second_look_forecast"])["second_look_forecast"].items()}
        sens[str(tg)] = s
        print(
            f"target {tg}: acc {s['accuracy']['mean']:.3f} crit R {s['critical_recall']['mean']:.3f} "
            f"P {s['critical_precision']['mean']:.3f} F2 {s['critical_f2']['mean']:.3f} "
            f"esc {int(s['escalations_caught']['sum'])} false {int(s['false_escalations']['sum'])}"
        )
    print("\n5-fold CV mean±sd (escalations and false escalations summed over folds)")
    print(_table(cv, cv))

    # 3. Secondary cohort: Kalent's 8,293-event protocol (final message < 1 d), from the same out-of-fold predictions.
    oof = pd.concat(oof).sort_index()
    sec = oof[final_tca.loc[oof.index].to_numpy() < 1.0]
    sec_by_fold = [
        {m: score(g["y"].to_numpy(), g[f"pred_{m}"].to_numpy(), g["cut"].to_numpy()) for m in METHODS}
        for _, g in sec.groupby("fold")
    ]
    sec_cv = summarise(sec_by_fold)
    print(f"\nKalent cohort (n={len(sec)}), CV mean±sd")
    print(_table(sec_cv, sec_cv))

    # 4. Final model on all cohort events (nowcast tiers cross-fitted = the CV val nowcast), thresholds from CV OOF.
    nc_oof = pd.concat([f["_nc"] for f in folds])
    feats = event_features(inputs, nc_oof).loc[ids]
    p_oof = oof.loc[ids, ["p0", "p1", "p2"]].to_numpy()
    th = choose_thresholds(y, p_oof, floor_tier(feats))
    final = Forecaster().fit(feats, y)

    test = load_cdms(find_csv("test", RAW_DIR))
    tin = cutoff_inputs(test)
    with contextlib.redirect_stdout(io.StringIO()):
        from triage.train import train

        art = train(df)
    tnc = nowcast_table(art, tin)
    tfeats = event_features(tin, tnc)
    tp = final.predict_proba(tfeats)
    rec = decision_records(tfeats, tp, th)
    out = rec.drop(columns=["reasons"]).assign(top_reason=rec["reasons"].str[0])
    PREDICTIONS.parent.mkdir(exist_ok=True)
    out.reset_index().to_csv(PREDICTIONS, index=False, float_format="%.4f")

    demo_events = DEMO / "events.json"
    nowcast_match = None
    if demo_events.exists():
        demo_tier = {e["event_id"]: e["tier"] for e in json.loads(demo_events.read_text())["events"]}
        nowcast_match = int(sum(demo_tier.get(i) == t for i, t in tnc["nowcast_tier"].items()))
        if not args.no_events:
            add_to_events(demo_events, rec, th)

    def strip(s):
        return {k: v for k, v in s.items() if not k.startswith("_")}

    metrics = {
        "task": "Final tier (last message before TCA) from messages with time_to_tca >= 2 days (organisers)",
        "labels": {"source": "data/raw/labels/challenge1_event_labels.xlsx", **agreement},
        "cohort": {
            "definition": "usable_for_training == yes (>= 1 message 2+ days out)",
            "n_events": int(len(ids)),
            "final_tier_counts": {NAMES[t]: int((y == t).sum()) for t in Tier},
            "final_message_2d_or_more": int((final_tca.loc[ids] >= CUTOFF_DAYS).sum()),
            "escalations": int((y > cut_true.loc[ids].to_numpy()).sum()),
            "de_escalations": int((y < cut_true.loc[ids].to_numpy()).sum()),
        },
        "methods": METHODS,
        "decision_layer": {
            "floor": "Critical if the latest >=2 d message is Critical by rule (never lowered); else max(miss tier, "
            "team nowcast tier) - Pc-only Elevated lowered only by the constrained demoter",
            "escalation": "to Critical if P(final Critical) >= t_crit; to Elevated if P(final >= Elevated) >= t_elev",
            "t_crit_rule": f"loosest threshold reaching {CRITICAL_RECALL_TARGET:.0%} final-Critical recall on "
            "out-of-fold scores of the training portion",
            "t_elev_rule": "maximises F2 of final >= Elevated on the same out-of-fold scores",
            "shipped_thresholds": th,
            "probabilities": "scores of a class-weighted model: they rank events but overstate rare tiers; "
            "not calibrated probabilities",
        },
        "protocol_80_20": strip(split),
        "cv_5fold": {"folds": [strip(f) for f in folds], "summary": cv, "recall_target_sensitivity": sens},
        "secondary_cohort_kalent_8293": {
            "definition": ">= 1 message 2+ days out and final message < 1 day (ESA Kelvins protocol); scored from the "
            "5-fold CV out-of-fold predictions",
            "n_events": int(len(sec)),
            "summary": sec_cv,
        },
        "test_predictions": {
            "file": "predictions/test_final_tier.csv",
            "n_events": int(len(rec)),
            "by_predicted_final_tier": {NAMES[t]: int((rec["predicted_final_tier"] == t).sum()) for t in Tier},
            "by_floor_tier": {NAMES[t]: int((rec["floor_tier"] == t).sum()) for t in Tier},
            "escalated": int((rec["predicted_final_tier"] > rec["floor_tier"]).sum()),
            "nowcast_tier_matches_demo_events_tier": nowcast_match,
            "note": "test_data has no final outcomes: these are demo predictions, never scored",
        },
    }
    for folder in (REPORTS, DEMO):
        folder.mkdir(exist_ok=True)
        (folder / "forecast_metrics.json").write_text(json.dumps(metrics, indent=2, default=float))
    print("test:", metrics["test_predictions"])


if __name__ == "__main__":
    main()
