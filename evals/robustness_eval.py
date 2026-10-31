"""Robustness ("junk input") eval: does the pipeline reject, flag or safely tier inputs beyond the demo script?

    uv run python -m evals.robustness_eval            # prints a markdown table, exit 1 if any case fails
    uv run python evals/robustness_eval.py --json out.json

Each case writes a mutated copy of data/sample/cdm_sample.csv to a temp dir and runs it through
triage.predict.predict_file (the same path as `python -m triage.predict`), plus a few /api calls via TestClient.
Per case we record: crashed? clear error? tiers sane? and the invariant below.

Invariant checked on EVERY output row (the "rule floor"):
  * pred_tier is never below the miss-distance rule, and is Critical whenever max_risk_estimate >= -4;
  * pred_tier < baseline_tier is allowed only for a clean demotion candidate (Elevated purely from the Pc upper
    bound, miss > 5 km, covariance usable, no missing inputs) - the one documented place the model acts;
  * a row with a missing Pc upper bound or miss distance is never below Elevated.
Modelled on the lvl 500 HackHarvard 2026 junk_eval (candpixie/hackharvard26, chalk_tools/junk_eval*.py).
"""

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

if __package__ in (None, ""):  # run as a script: make the repo root importable
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from triage import model
from triage.data import SAMPLE_PATH
from triage.predict import predict_file
from triage.tiers import Tier, miss_tier, pc_tier

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-eval")  # server imports the agent client; no requests are made

# A few rows of the sample get mutated; chosen so each is its event's first (oldest) CDM.
FAR = 50_000.0  # miss distance well beyond 5 km, so only the Pc rule decides


@dataclass
class Case:
    name: str
    expect: str  # human-readable expectation for the table
    mutate: Callable[[pd.DataFrame], pd.DataFrame | str | None]  # returns df, raw text, or None (empty file)
    want: str = "ok"  # "ok" (scored), "reject" (clear ValueError), or "flag" (targets need_review / escalate)
    must_say: str = ""  # for "reject": the error message must contain this (a clear message, not a bare traceback)
    check: Callable[[pd.DataFrame, pd.DataFrame], str | None] | None = None  # (input, output) -> problem or None


def first_rows(df: pd.DataFrame, k: int) -> list[int]:
    return list(df.groupby("event_id", sort=False).head(1).index[:k])


def setv(rows, **vals):
    def f(df):
        df = df.copy()
        for col, v in vals.items():
            if isinstance(v, str):
                df[col] = df[col].astype(object)
            df.loc[rows, col] = v
        return df

    return f


def expect_baseline(tier: int):
    def check(inp, out):
        got = sorted(set(out.loc[TARGETS, "baseline_tier"]))
        return None if got == [tier] else f"baseline_tier {got}, expected {tier}"

    return check


def expect_pred_at_least(tier: int, review: bool = False):
    def check(inp, out):
        o = out.loc[TARGETS]
        if (o["pred_tier"] < tier).any():
            return f"pred_tier {sorted(set(o['pred_tier']))} below {Tier(tier).name}"
        if review and not (o["needs_review"] | (o["pred_tier"] == Tier.CRITICAL)).all():
            return "not flagged needs_review"
        return None

    return check


def both(*checks):
    def check(inp, out):
        return next((p for c in checks if (p := c(inp, out))), None)

    return check


def same_as_original(reorder: Callable[[pd.DataFrame], pd.DataFrame]):
    """Row-for-row the predictions must not depend on file order (rows matched via a hidden key)."""

    def mutate(df):
        return reorder(df.assign(_key=np.arange(len(df))))

    def check(inp, out):
        ref = predict_file(SAMPLE_PATH)
        mine = out.assign(_key=inp["_key"].to_numpy()).set_index("_key").sort_index()
        cols = ["pred_tier", "needs_review", "baseline_tier"]
        diff = (mine[cols].to_numpy() != ref[cols].to_numpy()).any(axis=1).sum()
        return None if diff == 0 else f"{diff} rows changed tier/review after reordering"

    return mutate, check


SAMPLE = pd.read_csv(SAMPLE_PATH)
TARGETS = first_rows(SAMPLE, 3)
shuffle_mut, shuffle_check = same_as_original(lambda d: d.sample(frac=1, random_state=0).reset_index(drop=True))


def last_cdm_close(df):
    """Move every event's final CDM to under one day before TCA (the test set has none < 1 day)."""
    df = df.copy()
    last = df.groupby("event_id")["time_to_tca"].idxmin()
    df.loc[last, "time_to_tca"] = 0.3
    return df


def tca_check(inp, out):
    n = int((out["time_to_tca"] < 1).sum())
    return None if n else "no rows under 1 day reached the output"


CASES = [
    Case(
        "missing required column",
        "reject: names the column",
        lambda d: d.drop(columns=["miss_distance"]),
        "reject",
        must_say="miss_distance",
    ),
    Case("extra unknown columns", "ignored, same tiers", lambda d: d.assign(mission_id=7, foo="bar")),
    Case("labels removed (live use)", "works without `risk`", lambda d: d.drop(columns=["risk"])),
    Case(
        "NaN miss_distance",
        ">= Elevated + needs_review",
        setv(TARGETS, miss_distance=np.nan, max_risk_estimate=-5.0),
        "flag",
        check=expect_pred_at_least(Tier.ELEVATED, review=True),
    ),
    Case(
        "NaN max_risk_estimate",
        ">= Elevated + needs_review",
        setv(TARGETS, max_risk_estimate=np.nan, miss_distance=FAR),
        "flag",
        check=expect_pred_at_least(Tier.ELEVATED, review=True),
    ),
    Case(
        "non-numeric miss_distance",
        "reject: names column + value",
        setv(TARGETS[:1], miss_distance="far away"),
        "reject",
        must_say="'miss_distance'",
    ),
    Case(
        "negative miss distance",
        "Critical (miss < 1 km rule)",
        setv(TARGETS, miss_distance=-250.0),
        check=expect_pred_at_least(Tier.CRITICAL),
    ),
    Case(
        "miss exactly 1000 m",
        "baseline Elevated, pred >= Elevated",
        setv(TARGETS, miss_distance=1000.0, max_risk_estimate=-10.0),
        check=both(expect_baseline(Tier.ELEVATED), expect_pred_at_least(Tier.ELEVATED)),
    ),
    Case(
        "miss exactly 5000 m",
        "baseline Elevated, pred >= Elevated",
        setv(TARGETS, miss_distance=5000.0, max_risk_estimate=-10.0),
        check=both(expect_baseline(Tier.ELEVATED), expect_pred_at_least(Tier.ELEVATED)),
    ),
    Case(
        "max_risk_estimate exactly -4",
        "Critical",
        setv(TARGETS, max_risk_estimate=-4.0, miss_distance=FAR),
        check=both(expect_baseline(Tier.CRITICAL), expect_pred_at_least(Tier.CRITICAL)),
    ),
    Case(
        "max_risk_estimate exactly -6",
        "baseline Elevated (model may demote)",
        setv(TARGETS, max_risk_estimate=-6.0, miss_distance=FAR),
        check=expect_baseline(Tier.ELEVATED),
    ),
    Case(
        "risk floor -30",
        "below threshold, no crash",
        setv(TARGETS, max_risk_estimate=-30.0, miss_distance=FAR),
        check=expect_baseline(Tier.SAFE),
    ),
    Case(
        "placeholder sigma 63,781,360 m",
        "never demoted, needs_review",
        setv(TARGETS, c_sigma_r=63_781_360.0, max_risk_estimate=-5.0, miss_distance=FAR),
        "flag",
        check=expect_pred_at_least(Tier.ELEVATED, review=True),
    ),
    Case(
        "NaN c_sigma_r",
        "never demoted, needs_review",
        setv(TARGETS, c_sigma_r=np.nan, max_risk_estimate=-5.0, miss_distance=FAR),
        "flag",
        check=expect_pred_at_least(Tier.ELEVATED, review=True),
    ),
    Case(
        "unknown c_object_type",
        "no crash, needs_review",
        setv(TARGETS, c_object_type="ALIEN SHIP", max_risk_estimate=-5.0, miss_distance=FAR),
        "flag",
        check=expect_pred_at_least(Tier.ELEVATED, review=True),
    ),
    Case(
        "huge / infinite values",
        "no crash, Critical where Pc > 1e-4",
        setv(TARGETS, miss_distance=1e300, relative_speed=np.inf, max_risk_estimate=1e6, c_sigma_r=1e300),
        check=expect_pred_at_least(Tier.CRITICAL),
    ),
    Case("single-CDM event", "tiered from one CDM", lambda d: d.iloc[[TARGETS[0]]].reset_index(drop=True)),
    Case("shuffled row order", "identical per-row output", shuffle_mut, check=shuffle_check),
    Case("duplicated rows", "no crash, invariant holds", lambda d: pd.concat([d, d], ignore_index=True)),
    Case("time_to_tca < 1 day", "no crash, invariant holds", last_cdm_close, check=tca_check),
    Case("header only (0 rows)", "0 rows out, no crash", lambda d: d.iloc[:0]),
    Case("empty file (0 bytes)", "reject: says file is empty", lambda d: None, "reject", must_say="empty"),
]


def rule_floor_violations(inp: pd.DataFrame, out: pd.DataFrame) -> int:
    """Rows where pred_tier is below what the deterministic rules allow (see module docstring)."""
    if out.empty:
        return 0
    upper = pd.to_numeric(inp["max_risk_estimate"], errors="coerce").to_numpy(dtype=float)
    miss = pd.to_numeric(inp["miss_distance"], errors="coerce").to_numpy(dtype=float)
    sig = inp[["c_sigma_r", "t_sigma_r"]].apply(pd.to_numeric, errors="coerce")
    pred, base = out["pred_tier"].to_numpy(), out["baseline_tier"].to_numpy()
    missing = np.isnan(upper) | np.isnan(miss)
    floor = np.maximum(miss_tier(miss), np.where(pc_tier(upper) == Tier.CRITICAL, Tier.CRITICAL, Tier.SAFE))
    floor = np.where(missing, np.maximum(floor, Tier.ELEVATED), floor)
    clean_candidate = (
        (miss_tier(miss) == Tier.SAFE)
        & (pc_tier(upper) == Tier.ELEVATED)
        & ~missing
        & (sig < 1e7).all(axis=1).to_numpy()
        & inp["c_object_type"].isin(["DEBRIS", "PAYLOAD", "ROCKET BODY", "TBA", "UNKNOWN"]).to_numpy()
    )
    bad = (pred < floor) | ((pred < base) & ~clean_candidate)
    return int(bad.sum())


def run_case(case: Case, tmp: Path) -> dict:
    path = tmp / f"{case.name.replace(' ', '_').replace('/', '_')}.csv"
    data = case.mutate(SAMPLE.copy())
    if data is None:
        path.write_text("")
    else:
        data.to_csv(path, index=False)
    row = {"case": case.name, "expected": case.expect, "crashed": False, "error": None}
    try:
        out = predict_file(path)
    except ValueError as e:  # the pipeline's contract for bad input
        row["error"] = str(e).replace(str(tmp) + "/", "")
        row["observed"] = f"rejected: {row['error'][:90]}"
        row["pass"] = case.want == "reject" and case.must_say in row["error"]
        return row
    except Exception as e:  # anything else is a crash with an unhelpful traceback
        row.update(crashed=True, error=f"{type(e).__name__}: {e}")
        row["observed"] = f"CRASH {type(e).__name__}: {str(e)[:80]}"
        row["pass"] = False
        return row
    inp = data.reset_index(drop=True)
    problems = []
    if case.want == "reject":
        problems.append("accepted bad input without error")
    if len(out) != len(inp):
        problems.append(f"{len(out)} rows out for {len(inp)} in")
    if not out["pred_tier"].isin([0, 1, 2]).all() or out["confidence"].isna().any():
        problems.append("tier/confidence out of range")
    if n := rule_floor_violations(inp, out):
        problems.append(f"{n} rows below the rule floor")
    if case.check and not problems:
        if p := case.check(inp, out):
            problems.append(p)
    tiers = out["pred_tier"].value_counts().sort_index().to_dict()
    summary = f"{len(out)} rows, tiers {tiers}, {int(out['needs_review'].sum())} need review"
    if case.check:
        t = out.loc[[i for i in TARGETS if i in out.index]]
        if len(t) and case.name not in ("shuffled row order", "time_to_tca < 1 day", "single-CDM event"):
            summary = (
                f"targets: tier {sorted(set(t['pred_tier']))}, baseline {sorted(set(t['baseline_tier']))}, "
                f"review {sorted(set(t['needs_review']))}"
            )
    row["observed"] = summary + (f" - {'; '.join(problems)}" if problems else "")
    row["pass"] = not problems
    return row


def api_cases() -> list[dict]:
    from fastapi.testclient import TestClient

    from server import app

    client = TestClient(app)
    calls = [
        ("GET /api/events/999999", "/api/events/999999", 404, "unknown id -> 404 with message"),
        ("GET /api/events/abc", "/api/events/abc", 422, "non-integer id -> 422 with message"),
        ("GET /api/events?tier=abc", "/api/events?tier=abc", 422, "bad filter -> 422"),
        ("GET /api/explain/999999?llm=false", "/api/explain/999999?llm=false", 404, "unknown id -> 404"),
    ]
    rows = []
    for name, url, code, expect in calls:
        try:
            r = client.get(url)
            detail = r.json().get("detail")
            msg = detail if isinstance(detail, str) else (detail or [{}])[0].get("msg", "")
            ok = r.status_code == code and bool(msg)
            rows.append(
                {"case": name, "expected": expect, "crashed": False, "observed": f"{r.status_code}: {msg}", "pass": ok}
            )
        except Exception as e:
            rows.append(
                {"case": name, "expected": expect, "crashed": True, "observed": f"CRASH {e!r}"[:120], "pass": False}
            )
    return rows


def run() -> list[dict]:
    with tempfile.TemporaryDirectory() as d:
        rows = [run_case(c, Path(d)) for c in CASES]
    return rows + api_cases()


def table(rows: list[dict]) -> str:
    lines = ["| Case | Expected | Observed | Result |", "|---|---|---|---|"]
    for r in rows:
        obs = r["observed"].replace("|", "/")
        lines.append(f"| {r['case']} | {r['expected']} | {obs} | {'pass' if r['pass'] else 'FAIL'} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="also write the rows as JSON here")
    args = ap.parse_args()
    mode = "trained demotion model" if model.load_artifact() else "baseline rules only (no reports/model.joblib)"
    rows = run()
    print(f"Model: {mode}\n")
    print(table(rows))
    n_pass = sum(r["pass"] for r in rows)
    print(f"\n{n_pass}/{len(rows)} pass, {sum(r['crashed'] for r in rows)} crashed")
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2, default=str))
    sys.exit(0 if n_pass == len(rows) else 1)


if __name__ == "__main__":
    main()
