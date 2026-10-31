"""Score the event action queue (triage/actions.py) with Kalent's forecast protocol, on TRAIN only.

    uv run python scripts/eval_actions.py            # ~5 min the first time (refits the nowcast per fold), then cached
    uv run python scripts/eval_actions.py --refresh  # rebuild the out-of-fold event cache

Protocol (docs/algorithm/algorithm.md §1.4):
- Events with at least one CDM >= 2 days before TCA and a final CDM < 1 day before TCA (8,293 train events).
- Input: only the CDMs >= 2 days out, run through the same pipeline as the dashboard: triage.model.predict for
  the per-CDM tiers and triage.build_events.build for the event dicts. The nowcast model itself is refit
  out-of-fold (event-grouped), so no held-out event was seen by the model that tiers it.
- Truth: the final CDM's true tier, from risk + miss distance (risk is the label only, never an input).
- Escalation: final true tier > true tier of the last CDM >= 2 days out (244 events).
- Thresholds of the trend rule are tuned by event-grouped CV on train only. Test has no CDM < 2 days before
  TCA, so this metric cannot be computed on test at all.

Writes reports/action_eval.json.
"""

import argparse
import itertools
import json
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from triage import actions  # noqa: E402
from triage.build_events import build  # noqa: E402
from triage.data import EVENT, RAW_DIR, find_csv, load_cdms  # noqa: E402
from triage.tiers import Tier  # noqa: E402
from triage.train import train  # noqa: E402

CUTOFF_DAYS = 2.0
FINAL_MAX_DAYS = 1.0  # Kalent's protocol (ESA Kelvins): final CDM < 1 day before TCA
N_FOLDS = 5
CACHE = ROOT / "reports" / "action_eval_events.pkl"
OUT = ROOT / "reports" / "action_eval.json"
QUEUE_RANK = {actions.MONITOR: 0, actions.REVIEW: 1, actions.MANEUVER: 2}


def protocol_split(df: pd.DataFrame):
    """(eval event ids, inputs = CDMs >= 2 d of those events, truth table per event)."""
    g = df.groupby(EVENT)["time_to_tca"]
    ok = (g.max() >= CUTOFF_DAYS) & (g.min() < FINAL_MAX_DAYS)
    ids = ok[ok].index
    ev = df[df[EVENT].isin(ids)]
    final = ev.loc[ev.groupby(EVENT)["time_to_tca"].idxmin()].set_index(EVENT)
    inp = ev[ev["time_to_tca"] >= CUTOFF_DAYS]
    cut = inp.loc[inp.groupby(EVENT)["time_to_tca"].idxmin()].set_index(EVENT)
    truth = pd.DataFrame({"final_tier": final["true_tier"], "cutoff_true_tier": cut["true_tier"]}).loc[ids]
    return ids, inp, truth


def oof_events(df: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Event dicts built from CDMs >= 2 d, with the nowcast model refit without each held-out fold's events."""
    ids, inp, truth = protocol_split(df)
    folds = StratifiedGroupKFold(n_splits=N_FOLDS, shuffle=True, random_state=0)
    truth["fold"] = -1
    events = []
    for k, (_, va) in enumerate(folds.split(truth, truth["final_tier"], groups=truth.index)):
        held = truth.index[va]
        truth.loc[held, "fold"] = k
        print(f"fold {k + 1}/{N_FOLDS}: refitting the nowcast without {len(held):,} held-out events")
        artifact = train(df[~df[EVENT].isin(held)].reset_index(drop=True))
        events += build(inp[inp[EVENT].isin(held)].reset_index(drop=True), artifact)["events"]
    return events, truth


def load_events(refresh: bool) -> tuple[list[dict], pd.DataFrame]:
    if CACHE.exists() and not refresh:
        return pickle.loads(CACHE.read_bytes())
    df = load_cdms(find_csv("train", RAW_DIR))
    out = oof_events(df)
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_bytes(pickle.dumps(out))
    return out


def strip_labels(e: dict) -> dict:
    """The decision layer never sees labels: drop true_tier and risk_log10 before calling action()."""
    e = {k: v for k, v in e.items() if k != "true_tier"}
    e["history"] = [{k: v for k, v in h.items() if k != "risk_log10"} for h in e["history"]]
    return e


def persistence(e: dict) -> dict:
    """Baseline: queue from the current (nowcast) tier only."""
    q = {Tier.CRITICAL: actions.MANEUVER, Tier.ELEVATED: actions.REVIEW}.get(e["tier"], actions.MONITOR)
    return {"queue": q, "escalation_watch": False}


def score(decisions: list[dict], truth: pd.DataFrame) -> dict:
    q = np.array([d["queue"] for d in decisions])
    watch = np.array([d["escalation_watch"] for d in decisions])
    final = truth["final_tier"].to_numpy()
    esc = final > truth["cutoff_true_tier"].to_numpy()
    rank = np.array([QUEUE_RANK[x] for x in q])
    crit = final == Tier.CRITICAL
    return {
        "n_events": int(len(q)),
        "final_critical": int(crit.sum()),
        "critical_coverage": float((rank[crit] >= 1).mean()) if crit.any() else 1.0,
        "critical_in_monitor": int((crit & (rank == 0)).sum()),
        "critical_in_maneuver": int((crit & (rank == 2)).sum()),
        "escalations": int(esc.sum()),
        "escalations_out_of_monitor": int((esc & (rank >= 1)).sum()),
        "escalations_queued_at_final_tier": int((esc & (rank >= final)).sum()),
        "escalation_watch_flags": int(watch.sum()),
        "escalation_watch_true": int((watch & esc).sum()),
        "escalation_watch_false": int((watch & ~esc).sum()),
        "below_to_higher": int((esc & (truth["cutoff_true_tier"].to_numpy() == 0)).sum()),
        "below_to_higher_out_of_monitor": int((esc & (truth["cutoff_true_tier"].to_numpy() == 0) & (rank >= 1)).sum()),
        "queue_share": {name: float((q == name).mean()) for name in QUEUE_RANK},
        "monitor_share": float((q == actions.MONITOR).mean()),
    }


def decide(events, params=None):
    return [actions.action(e, params) for e in events]


LAMBDA = 0.2  # one escalation flagged is worth five non-escalating events flagged (needs precision > 1/6)


def objective(s: dict, lam: float = LAMBDA) -> float:
    """Higher is better: escalations the watch flags minus lam x non-escalating events it flags."""
    return s["escalation_watch_true"] - lam * s["escalation_watch_false"]


GRID = {
    "near_elevated_m": [6_000.0, 7_500.0, 10_000.0],
    "near_critical_m": [1_500.0, 2_000.0, 2_500.0],
    "trend_free_frac": [0.0, 0.2, 0.5],
    "min_updates": [2, 3],
    "min_shrink": [0.1, 0.25],
    "require_pc_rising": [False, True],
    "swing": [0.2, 0.5, 1e9],
}


def grid():
    keys = list(GRID)
    for vals in itertools.product(*(GRID[k] for k in keys)):
        yield dict(zip(keys, vals, strict=True))


def tune(ordered, truth, lam: float = LAMBDA) -> tuple[dict, list[dict], dict]:
    """Event-grouped CV: pick params on 4 folds, apply them to the 5th. Returns the params picked on all train eval
    events (shipped as DEFAULTS), the out-of-fold decisions and the per-fold picks."""
    folds = truth["fold"].to_numpy()
    candidates = list(grid())
    cache = [decide(ordered, p) for p in candidates]
    oof = [None] * len(ordered)
    picks = {}
    for k in range(N_FOLDS):
        tr = folds != k
        best = max(
            range(len(candidates)),
            key=lambda i: objective(score([d for d, m in zip(cache[i], tr, strict=True) if m], truth[tr]), lam),
        )
        picks[k] = candidates[best]
        for j in np.flatnonzero(~tr):
            oof[j] = cache[best][j]
    best_all = max(range(len(candidates)), key=lambda i: objective(score(cache[i], truth), lam))
    return candidates[best_all], oof, picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-tune", action="store_true", help="score the shipped defaults only")
    args = ap.parse_args()
    events, truth = load_events(args.refresh)
    by_id = {e["event_id"]: strip_labels(e) for e in events}
    ordered = [by_id[i] for i in truth.index]

    results = {
        "persistence": score([persistence(e) for e in ordered], truth),
        "action_queue_no_watch": score(decide(ordered, {"near_elevated_m": 0.0, "near_critical_m": 0.0}), truth),
        "action_queue_defaults": score(decide(ordered), truth),
    }
    report = {"protocol": __doc__.split("Writes")[0].strip(), "defaults": actions.DEFAULTS}
    if not args.no_tune:
        best, oof, picks = tune(ordered, truth)
        results["action_queue_cv"] = score(oof, truth)
        report["cv_picks"] = picks
        report["picked_on_all_train"] = best
        report["lambda"] = LAMBDA
        report["lambda_sensitivity_cv"] = {}
        for lam in (0.1, 0.33):
            _, oof_lam, _ = tune(ordered, truth, lam)
            report["lambda_sensitivity_cv"][lam] = score(oof_lam, truth)
    report["results"] = results
    OUT.write_text(json.dumps(report, indent=2, default=str))
    rows = [
        ("final-Critical events", "final_critical"),
        ("Critical coverage (MANEUVER or REVIEW)", "critical_coverage"),
        ("final-Critical left in MONITOR", "critical_in_monitor"),
        ("final-Critical in MANEUVER PLANNING", "critical_in_maneuver"),
        ("escalations (of all eval events)", "escalations"),
        ("escalations out of MONITOR", "escalations_out_of_monitor"),
        ("escalations queued at final tier", "escalations_queued_at_final_tier"),
        ("below->higher escalations out of MONITOR", "below_to_higher_out_of_monitor"),
        ("escalation_watch flags", "escalation_watch_flags"),
        ("  of which escalated", "escalation_watch_true"),
        ("  of which did not (false)", "escalation_watch_false"),
        ("MONITOR share (workload saved)", "monitor_share"),
    ]
    names = list(results)
    print(f"\n{'metric':44s}" + "".join(f"{n:>24s}" for n in names))
    for label, key in rows:
        vals = [results[n][key] for n in names]
        print(f"{label:44s}" + "".join(f"{v:>24.3f}" if isinstance(v, float) else f"{v:>24d}" for v in vals))
    for n in names:
        print(n, {k: round(v, 3) for k, v in results[n]["queue_share"].items()})
    if "cv_picks" in report:
        print("cv picks per fold:", json.dumps(report["cv_picks"]))
        print("picked on all train:", report["picked_on_all_train"])
    for lam, s in report.get("lambda_sensitivity_cv", {}).items():
        print(
            f"CV with lambda={lam}: watch {s['escalation_watch_true']} true / {s['escalation_watch_false']} false, "
            f"escalations out of MONITOR {s['escalations_out_of_monitor']}, Critical in MONITOR "
            f"{s['critical_in_monitor']}, MONITOR share {s['monitor_share']:.3f}"
        )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
