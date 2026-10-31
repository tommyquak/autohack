"""Official task: forecast each event's FINAL tier from its messages >= 2 days before TCA, with a bounded decision.

    uv run python -m triage.forecast        # ~15 min the first time (refits the nowcast per fold), then cached

Bounded decision layer (every event gets a decision record, every step is a stated comparison):
- floor = Critical if the latest >= 2-day message is Critical by rule (Pc upper bound >= 1e-4 or miss < 1 km):
  never downgraded. Otherwise the miss-distance tier, raised to the team nowcast's tier at that message: an event that
  is Elevated only because of the Pc upper bound stays Elevated unless the existing constrained demoter
  (triage.model, 99% recall target on truly-Elevated messages) removes it.
- the model may only ESCALATE: to Critical when its score for "final Critical" is >= t_crit, to Elevated when its
  score for "final Elevated or worse" is >= t_elev. predicted_final = max(floor, escalation).
- t_crit: the HIGHEST threshold that still reaches the final-Critical recall target on out-of-fold scores of the
  training portion only (the fewest escalations that meet the target). t_elev maximises F2 of "final >= Elevated" on the
  same out-of-fold scores.

Model: two class-weighted HistGradientBoosting classifiers with monotonic constraints, for final >= Elevated and
final >= Critical (cumulative ordinal model). Their outputs are uncalibrated SCORES (class-weighted): they rank events
and are never shown or used as probabilities.

Rule-only baselines on the same floor and folds (docs/FORECAST.md): one Critical miss line (`floor_miss_line`, the
verifier's m* rule) and two miss lines (`floor_two_lines`, Critical line for the same recall target + an Elevated line
for F2). The two-line rule is the strongest: the model's edge over it is small, so it is reported next to every
shipped number.

Protocol (organisers first): one seeded 80/20 event split stratified by final tier, then 5-fold event CV. One row per
event, so no event is ever split. The nowcast is refit inside every split without the held-out events (its training
events get inner cross-fitted nowcast tiers). Thresholds are chosen inside the training portion (nested). test_data
has no final outcomes: it gets demo predictions only, never a score.

Writes data/demo/forecast_metrics.json, reports/forecast_metrics.json, predictions/test_final_tier.csv and a
`forecast` object per event in data/demo/events.json (and reports/events.json if present; existing fields unchanged,
asserted). triage.build_events re-attaches the forecast from predictions/test_final_tier.csv after a rebuild.
"""

import argparse
import contextlib
import hashlib
import inspect
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
    NOT_MODEL_INPUTS,
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
CRITICAL_RECALL_TARGET = 0.90
SENSITIVITY_TARGETS = (0.85, 0.90, 0.95)
N_FOLDS = 5
SEED = 0
NAMES = [TIER_NAMES[t] for t in Tier]
# Every source file the cached nowcast depends on: a change to any of them (or to the data or split) is a cache miss.
NOWCAST_SOURCES = ["model.py", "train.py", "features.py", "tiers.py", "data.py", "forecast_features.py"]
SCORE_NOTE = "uncalibrated class-weighted model score (ranks events; not a probability)"


# ---------- nowcast at the latest >= 2-day message ----------


def nowcast_table(artifact: dict | None, inputs: pd.DataFrame) -> pd.DataFrame:
    """The team nowcast (triage.model) at each event's latest >= 2-day message: tier, demotion score and whether an
    input was untrusted (then the nowcast is not allowed to demote)."""
    det = nowcast_model.predict_detailed(inputs, artifact)
    _, untrusted = nowcast_model.input_flags(inputs)
    t = pd.DataFrame(
        {
            EVENT: inputs[EVENT],
            "tca": inputs["time_to_tca"],
            "nowcast_tier": det["pred_tier"],
            "p": det["p_elevated"],
            "u": untrusted.astype(int),
        }
    )
    last = t.loc[t.groupby(EVENT)["tca"].idxmin()].set_index(EVENT)
    return last[["nowcast_tier"]].assign(nowcast_p_elevated=last["p"], nowcast_untrusted=last["u"])


def _fit_nowcast(df_all: pd.DataFrame, exclude) -> dict:
    from triage.train import train

    with contextlib.redirect_stdout(io.StringIO()):
        return train(df_all[~df_all[EVENT].isin(exclude)].reset_index(drop=True))


def data_fingerprint(df: pd.DataFrame) -> str:
    """Content hash of the training CDMs (row order included)."""
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=False).to_numpy().tobytes()).hexdigest()[:16]


def cache_key(split: str, data_fp: str, train_ids, val_ids) -> str:
    """Split name + hash of the nowcast's code, the data and the split ids."""
    h = hashlib.sha256()
    for name in NOWCAST_SOURCES:
        h.update((ROOT / "triage" / name).read_bytes())
    for fn in (nowcast_table, _fit_nowcast, crossfit_nowcast):
        h.update(inspect.getsource(fn).encode())
    h.update(data_fp.encode())
    h.update(np.sort(np.asarray(train_ids)).tobytes())
    h.update(np.sort(np.asarray(val_ids)).tobytes())
    return f"{split}_{h.hexdigest()[:16]}"


def crossfit_nowcast(df_all, inputs, train_ids, val_ids, key: str, inner: int = 3) -> pd.DataFrame:
    """Nowcast tiers for val (model fit without val events) and for train (inner folds, also without val events).
    `key` comes from cache_key(); files for the same split with another hash are stale and removed."""
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
    split = key.rsplit("_", 1)[0]
    for old in CACHE.glob(f"nowcast_{split}*.pkl"):
        old.unlink()
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
    """Cumulative ordinal model: scores for final >= Elevated and final >= Critical, monotonic and class-weighted.
    predict_proba returns [below, Elevated, Critical] score shares: they rank events but are not calibrated."""

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> "Forecaster":
        self.columns = [c for c in X.columns if c not in NOT_MODEL_INPUTS]
        self.ge = {
            k: _hgb(self.columns).fit(X[self.columns], (y >= k).astype(int)) for k in (Tier.ELEVATED, Tier.CRITICAL)
        }
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


def escalate(floor: np.ndarray, to_critical: np.ndarray, to_elevated: np.ndarray) -> np.ndarray:
    """predicted_final = max(floor, escalation). Escalation can only raise: the floor is never lowered."""
    esc = np.where(to_critical, Tier.CRITICAL, np.where(to_elevated, Tier.ELEVATED, Tier.SAFE))
    return np.maximum(floor, esc).astype(int)


def decide(floor: np.ndarray, p: np.ndarray, t_elev: float, t_crit: float) -> np.ndarray:
    """Shipped decision: Critical if score(final Critical) >= t_crit, else Elevated if score(final >= Elevated) >=
    t_elev; never below the floor."""
    return escalate(floor, p[:, 2] >= t_crit, p[:, 1] + p[:, 2] >= t_elev)


def decide_lines(floor: np.ndarray, miss: np.ndarray, m_crit: float, m_elev: float) -> np.ndarray:
    """Rule-only baseline: Critical if latest miss <= m_crit, else Elevated if miss <= m_elev; never below the floor."""
    miss = np.asarray(miss, float)
    return escalate(floor, miss <= m_crit, miss <= m_elev)


def recall_cut(score: np.ndarray, y: np.ndarray, floor: np.ndarray, target: float) -> float:
    """Highest threshold on `score` (escalate to Critical when score >= it) that still reaches the final-Critical
    recall target on these (training) events: the fewest escalations that meet the target. inf = none needed."""
    crit = y == Tier.CRITICAL
    need = int(np.ceil(target * crit.sum())) - int((crit & (floor == Tier.CRITICAL)).sum())
    pool = np.sort(score[crit & (floor < Tier.CRITICAL)])[::-1]
    if need <= 0 or not len(pool):
        return float("inf")
    return float(pool[min(need, len(pool)) - 1])


def f2_cut(score: np.ndarray, y: np.ndarray, floor: np.ndarray, to_critical: np.ndarray) -> float:
    """Threshold on `score` (escalate to Elevated when score >= it) maximising F2 of final >= Elevated."""
    best, cut = -1.0, float("inf")
    for t in np.unique(np.quantile(score, np.linspace(0.5, 0.999, 200))):
        pred = escalate(floor, to_critical, score >= t)
        s = fbeta_score(y >= Tier.ELEVATED, pred >= Tier.ELEVATED, beta=2, zero_division=0)
        if s > best:
            best, cut = s, float(t)
    return cut


def choose_thresholds(y, p, floor, target: float = CRITICAL_RECALL_TARGET) -> dict:
    """Shipped thresholds from out-of-fold scores `p` of TRAINING events only: t_crit (highest threshold reaching the
    final-Critical recall target), then t_elev (maximises F2 of final >= Elevated given that Critical rule)."""
    t_crit = recall_cut(p[:, 2], y, floor, target)
    t_elev = f2_cut(p[:, 1] + p[:, 2], y, floor, p[:, 2] >= t_crit)
    return {"t_crit": t_crit, "t_elev": t_elev, "critical_recall_target": target}


def choose_two_lines(y, floor, miss, target: float = CRITICAL_RECALL_TARGET) -> dict:
    """Rule-only baseline from TRAINING events: m_crit (metres), the smallest miss line reaching the recall target,
    then m_elev (metres), the miss line maximising F2 of final >= Elevated."""
    miss = np.asarray(miss, float)
    m_crit = -recall_cut(-miss, y, floor, target)  # escalate when -miss >= -m_crit, i.e. miss <= m_crit
    m_elev = -f2_cut(-miss, y, floor, miss <= m_crit)
    return {"m_crit": m_crit, "m_elev": m_elev, "critical_recall_target": target}


def choose_hybrid_thresholds(y, p, floor, miss, target: float = CRITICAL_RECALL_TARGET) -> dict:
    """Ablation: the Critical miss line, then the model's >= Elevated score for Elevated escalation."""
    miss = np.asarray(miss, float)
    m_crit = -recall_cut(-miss, y, floor, target)
    t_elev = f2_cut(p[:, 1] + p[:, 2], y, floor, miss <= m_crit)
    return {"m_crit": m_crit, "t_elev": t_elev, "critical_recall_target": target}


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
        "predicted_critical": int(pcrit.sum()),
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
    "floor_miss_line": "Baseline: floor + Critical if latest miss <= m_crit (one line, no model)",
    "floor_two_lines": "Baseline: floor + Critical miss line + Elevated miss line (no model)",
    "hybrid_model_elevated": "Ablation: floor + Critical miss line + model escalates to Elevated",
    "bounded_rule_floor": "Ablation: shipped layer, Pc-only Elevated left as is",
    "second_look_forecast": "Second Look forecast (floor + model escalation to Critical and Elevated)",
}


def run_split(df_all, inputs, labels, cut_true, train_ids, val_ids, key) -> dict:
    """Fit on train_ids, choose thresholds on train-only data, score val_ids. Returns results + val outputs."""
    nc = crossfit_nowcast(df_all, inputs, train_ids, val_ids, key)
    feats = event_features(inputs[inputs[EVENT].isin(np.r_[train_ids, val_ids])], nc)
    y_all = labels["final_tier"]
    Xtr, ytr = feats.loc[train_ids], y_all.loc[train_ids].to_numpy()
    Xva, yva = feats.loc[val_ids], y_all.loc[val_ids].to_numpy()
    oof = np.zeros((len(Xtr), 3))
    for a, b in StratifiedKFold(N_FOLDS, shuffle=True, random_state=SEED + 1).split(Xtr, ytr):
        oof[b] = Forecaster().fit(Xtr.iloc[a], ytr[a]).predict_proba(Xtr.iloc[b])
    fl_tr, fl_va = floor_tier(Xtr), floor_tier(Xva)
    fr_tr, fr_va = floor_tier(Xtr, "rule"), floor_tier(Xva, "rule")
    m_tr, m_va = Xtr["miss_latest"].to_numpy(), Xva["miss_latest"].to_numpy()
    th = choose_thresholds(ytr, oof, fl_tr)
    th_rule = choose_thresholds(ytr, oof, fr_tr)
    th_lines = choose_two_lines(ytr, fl_tr, m_tr)
    th_hybrid = choose_hybrid_thresholds(ytr, oof, fl_tr, m_tr)
    p = Forecaster().fit(Xtr, ytr).predict_proba(Xva)
    s_va = p[:, 1] + p[:, 2]
    cut = cut_true.loc[val_ids].to_numpy()
    none = np.zeros(len(yva), bool)
    preds = {
        "always_below_threshold": np.zeros(len(yva), int),
        "persistence_miss": Xva["miss_tier"].to_numpy(),
        "persistence_rule": Xva["rule_tier"].to_numpy(),
        "persistence_nowcast": Xva["nowcast_tier"].to_numpy().astype(int),
        "reference_persistence_risk": cut,
        "model_argmax_unbounded": p.argmax(1),
        "floor_miss_line": escalate(fl_va, m_va <= th_lines["m_crit"], none),
        "floor_two_lines": decide_lines(fl_va, m_va, th_lines["m_crit"], th_lines["m_elev"]),
        "hybrid_model_elevated": escalate(fl_va, m_va <= th_hybrid["m_crit"], s_va >= th_hybrid["t_elev"]),
        "bounded_rule_floor": decide(fr_va, p, th_rule["t_elev"], th_rule["t_crit"]),
        "second_look_forecast": decide(fl_va, p, th["t_elev"], th["t_crit"]),
    }
    sens = {}
    for tg in SENSITIVITY_TARGETS:
        t, tl = choose_thresholds(ytr, oof, fl_tr, tg), choose_two_lines(ytr, fl_tr, m_tr, tg)
        sens[str(tg)] = {
            "second_look_forecast": score(yva, decide(fl_va, p, t["t_elev"], t["t_crit"]), cut),
            "floor_two_lines": score(yva, decide_lines(fl_va, m_va, tl["m_crit"], tl["m_elev"]), cut),
        }
    return {
        "n_train": int(len(train_ids)),
        "n_val": int(len(val_ids)),
        "thresholds": th,
        "thresholds_rule_floor": th_rule,
        "thresholds_two_lines": th_lines,
        "thresholds_hybrid_model_elevated": th_hybrid,
        "results": {m: score(yva, preds[m], cut) for m in METHODS},
        # Cost of the recall target: the shipped layer and the two-line rule re-tuned (train-only) per target.
        "recall_target_sensitivity": sens,
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
    untrusted = bool(r.get("nowcast_untrusted", 0) == 1)
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
        if untrusted:
            return (
                f"Elevated floor {when}: an input at that update is missing or invalid, so the constrained demoter "
                "was not allowed to lower it"
            )
        if r["pc_bound_tier"] == Tier.ELEVATED:
            return (
                f"Elevated floor {when}: Pc upper bound 1e{r['mre_latest']:.1f} is in the Elevated band and the "
                "constrained demoter kept it"
            )
        return f"Elevated floor {when}: the dashboard nowcast holds this event at Elevated"
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
    """One record per event: floor, decision, the one comparison behind an escalation, up to 3 reasons."""
    floor = floor_tier(feats)
    pred = decide(floor, p, th["t_elev"], th["t_crit"])
    s_crit, s_elev = p[:, 2], p[:, 1] + p[:, 2]
    target = f"{th['critical_recall_target']:.0%}"
    rows = []
    for i, (eid, r) in enumerate(feats.iterrows()):
        fr = floor_reason(r, int(floor[i]))
        escalation = ""
        if pred[i] > floor[i] and pred[i] == Tier.CRITICAL:
            escalation = "model_score_critical"
            lead = (
                f"Forecast escalates to Critical: model score for a final tier of Critical is {s_crit[i]:.2f}, at or "
                f"above the threshold {th['t_crit']:.2f} (set on training events for a {target} final-Critical recall "
                "target; a ranking score, not a probability)"
            )
        elif pred[i] > floor[i]:
            escalation = "model_score_elevated"
            lead = (
                f"Forecast escalates to Elevated: model score for a final tier of Elevated or worse is "
                f"{s_elev[i]:.2f}, at or above the threshold {th['t_elev']:.2f} (a ranking score, not a probability)"
            )
        if escalation:
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
                "floor_tier": int(floor[i]),
                "floor_tier_name": NAMES[floor[i]],
                "decision": decision,
                "escalation_rule": escalation,
                "score_final_critical": float(s_crit[i]),
                "score_final_elevated_or_worse": float(s_elev[i]),
                "t_crit": float(th["t_crit"]),
                "t_elev": float(th["t_elev"]),
                "reasons": reasons[:3],
            }
        )
    return pd.DataFrame(rows).set_index(EVENT)


# ---------- predictions file and events.json ----------


def write_predictions(records: pd.DataFrame, path: Path = PREDICTIONS) -> None:
    out = records.assign(top_reason=records["reasons"].str[0], reasons=records["reasons"].map(json.dumps))
    path.parent.mkdir(exist_ok=True)
    out.reset_index().to_csv(path, index=False, float_format="%.4f")


def load_predictions(path: Path = PREDICTIONS) -> pd.DataFrame:
    rec = pd.read_csv(path, dtype={"escalation_rule": str}, keep_default_na=False).set_index(EVENT)
    rec["reasons"] = rec["reasons"].map(json.loads)
    return rec


def forecast_object(r: pd.Series) -> dict:
    """events.json `forecast` (docs/CONTRACT.md). No probabilities: the decision, its floor, the comparison behind an
    escalation, and the two model scores labelled as uncalibrated ranking scores."""
    esc = None
    if r["escalation_rule"] in ("model_score_critical", "model_score_elevated"):
        crit = r["escalation_rule"] == "model_score_critical"
        esc = {
            "rule": "model_score",
            "to_tier": int(Tier.CRITICAL if crit else Tier.ELEVATED),
            "score": "final_critical" if crit else "final_elevated_or_worse",
            "value": round(float(r["score_final_critical"] if crit else r["score_final_elevated_or_worse"]), 4),
            "threshold": round(float(r["t_crit"] if crit else r["t_elev"]), 4),
        }
    return {
        "predicted_final_tier": int(r["predicted_final_tier"]),
        "predicted_final_tier_name": r["predicted_final_tier_name"],
        "floor_tier": int(r["floor_tier"]),
        "floor_tier_name": r["floor_tier_name"],
        "decision": r["decision"],
        "escalation": esc,
        "scores": {
            "final_critical": round(float(r["score_final_critical"]), 4),
            "final_elevated_or_worse": round(float(r["score_final_elevated_or_worse"]), 4),
        },
        "score_note": SCORE_NOTE,
        "calibrated": False,
        "thresholds": {"t_crit": round(float(r["t_crit"]), 4), "t_elev": round(float(r["t_elev"]), 4)},
        "reasons": list(r["reasons"]),
    }


class ForecastMismatch(ValueError):
    """The forecast file does not belong to these events (other event set, or its floor differs from the tier)."""


def attach(data: dict, records: pd.DataFrame) -> dict:
    """Add a `forecast` object to every event in events.json content; every existing field is asserted unchanged.
    Refuses (ForecastMismatch) when the event ids differ or a floor differs from the event's dashboard tier: that means
    the forecast is stale against the nowcast that built these events."""
    ids = {e["event_id"] for e in data["events"]}
    if ids != set(records.index):
        raise ForecastMismatch(f"forecast covers {len(records)} events, events.json has {len(ids)} (other ids)")
    bad = [e["event_id"] for e in data["events"] if int(records.loc[e["event_id"], "floor_tier"]) != e["tier"]]
    if bad:
        raise ForecastMismatch(f"forecast floor differs from the dashboard tier on {len(bad)} events (stale forecast)")
    before = json.dumps({**data, "events": [{k: v for k, v in e.items() if k != "forecast"} for e in data["events"]]})
    for e in data["events"]:
        e["forecast"] = forecast_object(records.loc[e["event_id"]])
    after = json.dumps({**data, "events": [{k: v for k, v in e.items() if k != "forecast"} for e in data["events"]]})
    assert before == after, "adding the forecast changed an existing events.json field"
    for e in data["events"]:
        assert e["forecast"]["predicted_final_tier"] >= e["forecast"]["floor_tier"] == e["tier"]
        if e["tier"] == Tier.CRITICAL:
            assert e["forecast"]["predicted_final_tier"] == Tier.CRITICAL
    return data


def add_to_events(path: Path, records: pd.DataFrame, compact: bool) -> dict:
    data = attach(json.loads(path.read_text()), records)
    path.write_text(json.dumps(data, separators=(",", ":")) if compact else json.dumps(data, indent=2))
    return data


# ---------- main ----------


def _table(results: dict, sd: dict | None = None) -> str:
    keys = ["accuracy", "macro_f1", "critical_recall", "critical_precision", "critical_f2"]
    lines = []
    for m in METHODS:
        r = results[m]
        if sd is None:
            vals = [f"{r[k]:.3f}" for k in keys] + [f"{r['escalations_caught']}/{r['escalations']}"]
            vals += [str(r["false_escalations"]), str(r["predicted_critical"])]
        else:
            vals = [f"{sd[m][k]['mean']:.3f}±{sd[m][k]['sd']:.3f}" for k in keys]
            vals.append(f"{int(sd[m]['escalations_caught']['sum'])}/{int(sd[m]['escalations']['sum'])}")
            vals += [str(int(sd[m]["false_escalations"]["sum"])), str(int(sd[m]["predicted_critical"]["sum"]))]
        lines.append(f"{m:28s} " + " ".join(f"{v:>14s}" for v in vals))
    return "\n".join(lines)


def _range(folds: list[dict], key: str, name: str) -> dict:
    v = [f[key][name] for f in folds]
    return {"min": float(min(v)), "max": float(max(v)), "per_fold": [float(x) for x in v]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", help="organisers' xlsx (default data/raw/labels/challenge1_event_labels.xlsx)")
    ap.add_argument("--no-events", action="store_true", help="do not touch events.json")
    args = ap.parse_args()
    df = load_cdms(find_csv("train", RAW_DIR))
    labels = load_labels(args.labels) if args.labels else load_labels()
    agreement = label_agreement(labels, df)
    print("label agreement:", {k: v for k, v in agreement.items() if "confusion" not in k})
    data_fp = data_fingerprint(df)

    ids = labels.index[labels["usable"]].to_numpy()  # organisers' cohort: >= 1 message 2+ days out
    inputs = cutoff_inputs(df[df[EVENT].isin(ids)])
    cut_msgs = df[df["time_to_tca"] >= CUTOFF_DAYS]
    cut_msgs = cut_msgs.loc[cut_msgs.groupby(EVENT)["time_to_tca"].idxmin()].set_index(EVENT)
    cut_true = pd.Series(true_tier(cut_msgs[LABEL], cut_msgs["miss_distance"]), index=cut_msgs.index)
    y = labels.loc[ids, "final_tier"].to_numpy()
    final_tca = final_messages(df)["time_to_tca"]

    # 1. Organisers' protocol: one seeded 80/20 split, stratified by final tier.
    tr, va = train_test_split(ids, test_size=0.2, stratify=y, random_state=SEED)
    split = run_split(df, inputs, labels, cut_true, tr, va, cache_key("8020", data_fp, tr, va))
    print(f"\n80/20 (val n={len(va)}) thresholds {split['thresholds']}")
    print(_table(split["results"]))

    # 2. 5-fold event CV for stability.
    folds, oof = [], []
    for k, (a, b) in enumerate(StratifiedKFold(N_FOLDS, shuffle=True, random_state=SEED).split(ids, y)):
        print(f"CV fold {k + 1}/{N_FOLDS}")
        folds.append(
            run_split(df, inputs, labels, cut_true, ids[a], ids[b], cache_key(f"cv{k}", data_fp, ids[a], ids[b]))
        )
        oof.append(folds[-1]["_val"].assign(fold=k))
    cv = summarise([f["results"] for f in folds])
    sens = {}
    for tg in SENSITIVITY_TARGETS:
        ms = ["second_look_forecast", "floor_two_lines"]
        sens[str(tg)] = summarise_methods([f["recall_target_sensitivity"][str(tg)] for f in folds], ms)
        for m in ms:
            s = sens[str(tg)][m]
            print(
                f"target {tg} {m}: acc {s['accuracy']['mean']:.3f} crit R {s['critical_recall']['mean']:.3f} "
                f"P {s['critical_precision']['mean']:.3f} F2 {s['critical_f2']['mean']:.3f} "
                f"esc {int(s['escalations_caught']['sum'])} false {int(s['false_escalations']['sum'])}"
            )
    print("\n5-fold CV mean±sd (escalations, false escalations, predicted Critical summed over folds)")
    print(_table(cv, cv))
    stability = {
        "t_crit": _range(folds, "thresholds", "t_crit"),
        "t_elev": _range(folds, "thresholds", "t_elev"),
        "two_lines_m_crit_m": _range(folds, "thresholds_two_lines", "m_crit"),
        "two_lines_m_elev_m": _range(folds, "thresholds_two_lines", "m_elev"),
    }
    # Paired per-fold comparison with the strongest rule-only baseline (same folds, same floor).
    paired = {
        k: [float(f["results"]["second_look_forecast"][k] - f["results"]["floor_two_lines"][k]) for f in folds]
        for k in ("critical_recall", "critical_precision", "critical_f2", "accuracy", "macro_f1")
    }
    paired |= {
        k: [int(f["results"]["second_look_forecast"][k] - f["results"]["floor_two_lines"][k]) for f in folds]
        for k in ("escalations_caught", "false_escalations", "predicted_critical")
    }
    print("forecast minus two lines, per fold:", {k: [round(x, 3) for x in v] for k, v in paired.items()})
    print(
        "threshold stability across folds:", {k: (round(v["min"], 3), round(v["max"], 3)) for k, v in stability.items()}
    )

    # 3. Secondary cohort: Kalent's 8,293-event protocol (final message < 1 d), from the same out-of-fold predictions.
    # Closest to test: every test event's latest message is ~2.0-2.4 d out and its final message is not an input.
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
    th_lines = choose_two_lines(y, floor_tier(feats), feats["miss_latest"].to_numpy())
    final = Forecaster().fit(feats, y)

    test = load_cdms(find_csv("test", RAW_DIR))
    tin = cutoff_inputs(test)
    with contextlib.redirect_stdout(io.StringIO()):
        from triage.train import train

        art = train(df)
    tnc = nowcast_table(art, tin)
    tfeats = event_features(tin, tnc)
    rec = decision_records(tfeats, final.predict_proba(tfeats), th)
    write_predictions(rec)
    lines_test = decide_lines(
        floor_tier(tfeats), tfeats["miss_latest"].to_numpy(), th_lines["m_crit"], th_lines["m_elev"]
    )

    demo_events = DEMO / "events.json"
    nowcast_match = None
    if demo_events.exists():
        demo_tier = {e["event_id"]: e["tier"] for e in json.loads(demo_events.read_text())["events"]}
        nowcast_match = int(sum(demo_tier.get(i) == t for i, t in tnc["nowcast_tier"].items()))
        if not args.no_events:
            add_to_events(demo_events, rec, compact=True)  # same compact form as the frozen file
            if (REPORTS / "events.json").exists():
                try:
                    add_to_events(REPORTS / "events.json", rec, compact=False)
                except ForecastMismatch as err:
                    print(f"reports/events.json left without a forecast: {err}")

    def strip(s):
        return {k: v for k, v in s.items() if not k.startswith("_")}

    n_crit_test = int((rec["predicted_final_tier"] == Tier.CRITICAL).sum())
    sec_p = sec_cv["second_look_forecast"]["critical_precision"]["mean"]
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
            "escalation": "to Critical if score(final Critical) >= t_crit; else to Elevated if score(final >= "
            "Elevated) >= t_elev",
            "t_crit_rule": f"the highest threshold (fewest escalations) still reaching {CRITICAL_RECALL_TARGET:.0%} "
            "final-Critical recall on out-of-fold scores of the training portion",
            "t_elev_rule": "maximises F2 of final >= Elevated on the same out-of-fold scores",
            "shipped_thresholds": th,
            "two_lines_baseline_thresholds": th_lines,
            "threshold_stability_cv": stability,
            "paired_vs_two_lines_cv": paired,
            "scores": SCORE_NOTE,
        },
        "protocol_80_20": strip(split),
        "cv_5fold": {"folds": [strip(f) for f in folds], "summary": cv, "recall_target_sensitivity": sens},
        "secondary_cohort_kalent_8293": {
            "definition": ">= 1 message 2+ days out and final message < 1 day (ESA Kelvins protocol); scored from the "
            "5-fold CV out-of-fold predictions. The closest guide to test, where no final message is an input",
            "n_events": int(len(sec)),
            "summary": sec_cv,
        },
        "test_predictions": {
            "file": "predictions/test_final_tier.csv",
            "n_events": int(len(rec)),
            "by_predicted_final_tier": {NAMES[t]: int((rec["predicted_final_tier"] == t).sum()) for t in Tier},
            "by_floor_tier": {NAMES[t]: int((rec["floor_tier"] == t).sum()) for t in Tier},
            "escalated": int((rec["predicted_final_tier"] > rec["floor_tier"]).sum()),
            "escalated_to_critical": int(((rec["predicted_final_tier"] == 2) & (rec["floor_tier"] < 2)).sum()),
            "escalated_to_elevated": int(((rec["predicted_final_tier"] == 1) & (rec["floor_tier"] < 1)).sum()),
            "critical_queue": n_crit_test,
            "expected_final_critical_in_queue_at_cohort_precision": round(n_crit_test * sec_p),
            "two_lines_baseline_by_final_tier": {NAMES[t]: int((lines_test == t).sum()) for t in Tier},
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
