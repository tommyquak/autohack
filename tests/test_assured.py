"""Assured triage: per-decision certificates, GET /api/audit and POST /api/triage. No API key or raw data needed."""

import json
import os
import time
from pathlib import Path

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")  # client construction only; no requests are made

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import server
from triage import certify, model, reports
from triage.build_events import build
from triage.data import EVENT, FEATURES, SAMPLE_PATH, load_cdms
from triage.features import SIGMA_SENTINEL_M, build_features
from triage.predict import predict_file
from triage.tiers import Tier
from triage.train import candidates

DEMO_EVENTS = reports.DEMO / "events.json"


class DemoteEverything:
    """Stand-in classifier scoring every candidate 0, so anything the pipeline does not protect gets demoted."""

    def predict_proba(self, X):
        return np.column_stack([np.ones(len(X)), np.zeros(len(X))])


def demote_all(df):
    return {"model": DemoteEverything(), "columns": list(build_features(df).columns), "threshold": 0.5}


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture(scope="module")
def demo_text():
    return DEMO_EVENTS.read_text()


def serve(monkeypatch, folder: Path | None):
    """Point the report loader at `folder` (None: nothing in reports/, so the frozen demo copy is served)."""
    monkeypatch.setattr(reports, "REPORTS", folder if folder is not None else Path("/nonexistent-reports"))


# ---------- GET /api/audit ----------


def test_audit_passes_on_demo_data(client, monkeypatch):
    serve(monkeypatch, None)
    start = time.perf_counter()
    body = client.get("/api/audit").json()
    first = time.perf_counter() - start
    start = time.perf_counter()
    assert client.get("/api/audit").json() == body
    cached = time.perf_counter() - start

    assert body["status"] == "PASS", [c for c in body["checks"] if not c["passed"]]
    assert body["generated_at_source"] == "demo"
    names = {c["name"] for c in body["checks"]}
    assert {
        "critical_by_rule_stays_critical",
        "not_below_miss_rule",
        "unusable_uncertainty_not_demoted",
        "demotions_below_threshold",
        "certificates_consistent",
    } <= names
    assert all(set(c) >= {"name", "passed", "count", "detail"} for c in body["checks"])
    counts = body["counts"]
    assert counts["events"] == 2167 and counts["missing"] == 0
    assert counts["kept"] + counts["demoted"] + counts["not_eligible"] == counts["events"]
    assert counts["demoted"] > 0  # the model really acts on the demo data, and each demotion is re-verified
    cv = body["cv_evidence"]
    if cv["available"]:  # only real stored values, never numbers typed into a doc
        assert 0 < cv["oof_recall"] <= 1 and cv["threshold"] > 0 and cv["threshold_matches_certificates"]
    assert first < 1.0 and cached < 0.3


def _tamper_critical(doc):
    e = next(e for e in doc["events"] if e["tier"] == Tier.CRITICAL)
    e["tier"], e["tier_name"] = int(Tier.ELEVATED), "Elevated"
    return "critical_by_rule_stays_critical"


def _tamper_no_covariance(doc):
    sentinel = lambda e: max(e["latest"]["sigma_r_m"].values()) > SIGMA_SENTINEL_M  # noqa: E731
    e = next(e for e in doc["events"] if sentinel(e) and e["tier"] == Tier.ELEVATED)
    e["tier"], e["tier_name"] = int(Tier.SAFE), "Below threshold"
    e["certificate"]["tier"] = int(Tier.SAFE)  # even a matching certificate does not hide it
    return "unusable_uncertainty_not_demoted"


def _tamper_score(doc):
    e = next(e for e in doc["events"] if (e.get("certificate") or {}).get("decision") == "demoted")
    e["certificate"]["model_score"] = 2 * e["certificate"]["threshold"]  # the certificate still claims "holds"
    return "demotions_below_threshold"


@pytest.mark.parametrize("tamper", [_tamper_critical, _tamper_no_covariance, _tamper_score])
def test_tampered_events_fail_and_name_the_check(client, monkeypatch, tmp_path, demo_text, tamper):
    doc = json.loads(demo_text)
    expected = tamper(doc)
    (tmp_path / "events.json").write_text(json.dumps(doc))
    serve(monkeypatch, tmp_path)
    body = client.get("/api/audit").json()
    assert body["status"] == "FAIL" and body["generated_at_source"] == "reports"
    failed = {c["name"]: c for c in body["checks"] if not c["passed"]}
    assert expected in failed
    assert failed[expected]["violations"] >= 1 and "e.g." in failed[expected]["detail"]


def test_audit_fails_on_events_without_certificates(cdms):
    doc = build(cdms)
    for e in doc["events"]:
        e.pop("certificate")
    out = certify.audit(doc)
    assert out["status"] == "FAIL" and out["counts"]["missing"] == len(doc["events"])
    assert not next(c for c in out["checks"] if c["name"] == "certificates_consistent")["passed"]


# ---------- certificates ----------


def test_built_events_carry_certificates_that_pass_the_audit(cdms):
    doc = build(cdms)
    assert all(e["certificate"]["holds"] and e["certificate"]["tier"] == e["tier"] for e in doc["events"])
    assert certify.audit(doc)["status"] == "PASS"


def test_demo_events_unchanged_apart_from_certificates(demo_text):
    doc = json.loads(demo_text)
    assert doc["summary"]["by_tier"] == {"Below threshold": 1365, "Elevated": 606, "Critical": 196}
    assert all(e["certificate"]["tier"] == e["tier"] for e in doc["events"])


@pytest.mark.parametrize("which", ["saved", "rules only", "demote everything"])
def test_certificate_invariants_hold_on_the_sample(which):
    df = load_cdms(SAMPLE_PATH)
    artifact = {"saved": None, "rules only": {}, "demote everything": demote_all(df)}[which]
    plain = model.predict(df, artifact)
    out = model.predict_with_certificates(df, artifact)
    pd.testing.assert_frame_equal(out[plain.columns], plain)  # certificates never change a prediction
    certs = out["certificate"].tolist()
    assert all(c["holds"] for c in certs)
    assert all(c["tier"] == t for c, t in zip(certs, out["pred_tier"], strict=True))

    _, untrusted = model.input_flags(df)
    eligible = candidates(df) & ~untrusted  # where triage.model may act
    assert [c["candidate"] for c in certs] == list(eligible)
    for c in certs:
        assert c["decision"] in certify.DECISIONS and set(c["invariants"]) == set(certify.INVARIANTS)
        assert c["candidate"] == (c["why_not_candidate"] is None)
        if c["decision"] == "demoted":
            assert c["model_score"] < c["threshold"] and c["tier"] < c["rule_tier"]
        if c["rule_tier"] == Tier.CRITICAL:
            assert c["tier"] == Tier.CRITICAL
    if which == "rules only":
        assert not any(c["decision"] == "demoted" for c in certs)
    if which == "demote everything":
        assert sum(c["decision"] == "demoted" for c in certs) == int(eligible.sum())


def test_untrusted_inputs_are_certified_not_eligible(cdms):
    df = cdms.copy()
    target = df["event_id"] == 2  # conftest event 2: Elevated purely by the Pc upper bound, miss > 5 km
    df.loc[target & (df.index % 3 == 0), "c_sigma_r"] = 63_781_360.0
    df.loc[target & (df.index % 3 == 1), "c_object_type"] = np.nan  # unknown object type
    df.loc[target & (df.index % 3 == 2), "t_sigma_r"] = np.nan
    out = model.predict_with_certificates(df, demote_all(df))
    certs = out.loc[target, "certificate"].tolist()
    assert all(c["decision"] == "not eligible" and c["holds"] and c["input_flags"] for c in certs)
    assert (out.loc[target, "pred_tier"] >= Tier.ELEVATED).all()


# ---------- POST /api/triage ----------


def _rows(frame: pd.DataFrame) -> list[dict]:
    return json.loads(frame.to_json(orient="records"))


def test_triage_round_trips_the_sample_and_matches_predict_file(client):
    raw = pd.read_csv(SAMPLE_PATH)
    ref = predict_file(SAMPLE_PATH)
    # Whole events per request (<= 500 rows), so each event's history is the same as in the file.
    chunks, current = [], []
    for _, g in raw.groupby(EVENT, sort=False):
        if current and sum(map(len, current)) + len(g) > server.MAX_TRIAGE_ROWS:
            chunks.append(pd.concat(current))
            current = []
        current.append(g)
    chunks.append(pd.concat(current))
    got = {}
    for chunk in chunks:
        body = client.post("/api/triage", json={"cdms": _rows(chunk)}).json()
        assert body["all_invariants_hold"] and "risk" in body["ignored_columns"]
        for idx, r in zip(chunk.index, body["results"], strict=True):
            got[idx] = r
    assert len(got) == len(raw)
    for col in ("tier", "needs_review", "baseline_tier", "confidence"):
        src = {"tier": "pred_tier"}.get(col, col)
        assert [got[i][col] for i in ref["row"]] == ref[src].tolist(), col
    r = next(iter(got.values()))
    assert {"tier", "tier_name", "reasons", "certificate", "needs_review", "to_escalate"} <= set(r)


def test_triage_ignores_risk(client):
    rows = _rows(pd.read_csv(SAMPLE_PATH).head(200))
    with_label = client.post("/api/triage", json={"cdms": rows}).json()
    scrambled = [dict(r, risk=-1.0 * i) for i, r in enumerate(rows)]
    unlabeled = [{k: v for k, v in r.items() if k != "risk"} for r in rows]
    assert client.post("/api/triage", json={"cdms": scrambled}).json()["results"] == with_label["results"]
    assert client.post("/api/triage", json={"cdms": unlabeled}).json()["results"] == with_label["results"]


def _one(**overrides) -> dict:
    row = {c: v for c, v in _rows(pd.read_csv(SAMPLE_PATH).head(1))[0].items() if c in FEATURES}
    return row | overrides


def test_triage_margin_to_next_tier(client):
    body = client.post("/api/triage", json={"cdms": [_one(miss_distance=1430.0, max_risk_estimate=-5.1)]}).json()
    r = body["results"][0]
    assert r["tier_name"] == "Elevated" and r["event_id"] is None
    esc = r["to_escalate"]
    assert esc["next_tier"] == "Critical" and esc["miss_must_drop_below_m"] == 1000 and esc["miss_now_m"] == 1430
    assert esc["pc_bound_must_reach_log10"] == -4 and esc["pc_bound_now_log10"] == -5.1
    crit = client.post("/api/triage", json={"cdms": [_one(miss_distance=400.0)]}).json()["results"][0]
    assert crit["tier"] == Tier.CRITICAL and crit["to_escalate"]["next_tier"] is None


def test_triage_escalates_unknown_and_missing_input(client):
    rows = [
        _one(miss_distance=None),
        _one(max_risk_estimate=None, miss_distance=20_000.0),
        _one(c_object_type="ALIEN SHIP", miss_distance=20_000.0, max_risk_estimate=-5.0),
        _one(c_sigma_r=None, miss_distance=20_000.0, max_risk_estimate=-5.0),
    ]
    results = client.post("/api/triage", json={"cdms": rows}).json()["results"]
    for r in results:
        assert r["tier"] >= Tier.ELEVATED and r["needs_review"] and r["certificate"]["decision"] == "not eligible"
        assert r["certificate"]["input_flags"] and r["certificate"]["holds"]
    assert "miss distance missing" in " ".join(results[0]["reasons"])


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({}, "cdms"),
        ({"cdms": []}, "1-500"),
        ({"cdms": [_one()] * 501}, "1-500"),
        ({"cdms": "not a list"}, "list"),
        ({"cdms": [{"miss_distance": 1.0}]}, "missing"),
        ({"cdms": [_one(miss_distance="far away")]}, "cdms[0].miss_distance must be a number"),
        ({"cdms": [_one(), _one(max_risk_estimate=True)]}, "cdms[1].max_risk_estimate"),
        ({"cdms": [_one(c_object_type=3)]}, "c_object_type must be a string"),
        ({"cdms": [_one(event_id="abc")]}, "event_id must be an integer"),
    ],
)
def test_triage_rejects_bad_input_with_422(client, body, fragment):
    r = client.post("/api/triage", json=body)
    assert r.status_code == 422
    assert fragment in json.dumps(r.json()["detail"])


def test_assured_code_never_reads_the_label():
    root = Path(__file__).resolve().parent.parent
    for path in (root / "triage" / "certify.py", root / "server.py"):
        src = path.read_text()
        assert '"risk"' not in src and "'risk'" not in src and '"true_tier"' not in src and "LABEL" not in src


# ---------- hardening: gaps found by adversarial review of the audit and the live endpoint ----------


def _failed(out: dict) -> set[str]:
    return {c["name"] for c in out["checks"] if not c["passed"]}


@pytest.fixture
def demo_doc(demo_text):
    return json.loads(demo_text)


def test_demo_audit_passes_with_and_without_the_artifact(demo_doc):
    stored = demo_doc["model_evidence"]["threshold"]
    assert certify.audit(demo_doc)["status"] == "PASS"
    out = certify.audit(demo_doc, {"threshold": stored})
    assert out["status"] == "PASS" and out["cv_evidence"]["threshold_matches_loaded_model"] is True
    check = next(c for c in out["checks"] if c["name"] == "threshold_matches_model")
    assert check["count"] == sum(e["certificate"]["threshold"] is not None for e in demo_doc["events"]) > 0


def test_threshold_mismatch_fails(demo_doc):
    stored = demo_doc["model_evidence"]["threshold"]
    # 1. the served model is not the one events.json was built with
    out = certify.audit(demo_doc, {"threshold": stored * 1.01})
    assert out["status"] == "FAIL" and _failed(out) == {"threshold_matches_model"}
    assert out["cv_evidence"]["threshold_matches_loaded_model"] is False
    # 2. one certificate claims a different threshold (its score still sits below its own claim)
    e = next(e for e in demo_doc["events"] if e["certificate"]["decision"] == "demoted")
    e["certificate"]["threshold"] = 0.9
    assert "threshold_matches_model" in _failed(certify.audit(demo_doc))


def test_cv_evidence_says_where_it_was_read_from(demo_doc):
    cv = certify.audit(demo_doc)["cv_evidence"]
    assert cv["source"] == "read from events.json (copied from the artifact at build time)"
    assert cv["threshold_matches_loaded_model"] is None  # no artifact passed: not claimed either way
    demo_doc["model_evidence"] = None
    assert certify.audit(demo_doc)["cv_evidence"]["available"] is False


@pytest.mark.parametrize(
    "tamper",
    [
        lambda e: e["latest"].update(miss_distance_m=e["latest"]["miss_distance_m"] + 1.0),
        lambda e: e["latest"].update(max_risk_estimate_log10=e["latest"]["max_risk_estimate_log10"] - 0.01),
        lambda e: e["latest"]["sigma_r_m"].update(chaser=e["latest"]["sigma_r_m"]["chaser"] * 2),
        lambda e: e["history"][-1].pop("sigma_r_m"),
        lambda e: e.update(history=[]),
    ],
    ids=["miss", "pc", "sigma", "history-without-sigma", "no-history"],
)
def test_latest_must_equal_last_history_cdm(demo_doc, tamper):
    e = next(e for e in demo_doc["events"] if e["tier"] == Tier.SAFE and e["latest"]["miss_distance_m"] > 9_000)
    tamper(e)
    out = certify.audit(demo_doc)
    assert out["status"] == "FAIL" and "latest_matches_history" in _failed(out)


def test_deleted_event_and_empty_files_fail(client, monkeypatch, tmp_path, demo_doc):
    del demo_doc["events"][0]  # every remaining event is internally consistent
    out = certify.audit(demo_doc)
    assert out["status"] == "FAIL" and _failed(out) == {"events_complete"}
    for i, empty in enumerate(({}, {"summary": {"n_events": 0, "by_tier": {}}, "events": []}, {"events": "nope"})):
        folder = tmp_path / str(i)  # a fresh path per file, so the audit cache cannot answer for an earlier one
        folder.mkdir()
        (folder / "events.json").write_text(json.dumps(empty))
        serve(monkeypatch, folder)
        body = client.get("/api/audit").json()
        assert body["status"] == "FAIL" and "events_complete" in _failed(body), empty


def test_summary_must_match_recounted_tiers(demo_doc):
    demo_doc["summary"]["by_tier"]["Critical"] += 1
    assert _failed(certify.audit(demo_doc)) == {"events_complete"}


@pytest.mark.parametrize("bad_tier", [2.5, 2.0, "2", True, None, 3, -1])
def test_tiers_must_be_ints_0_1_2(demo_doc, bad_tier):
    e = next(e for e in demo_doc["events"] if e["tier"] == Tier.CRITICAL)
    e["tier"] = bad_tier
    out = certify.audit(demo_doc)
    assert out["status"] == "FAIL" and "tiers_well_formed" in _failed(out)


def test_history_tier_must_be_an_int(demo_doc):
    demo_doc["events"][0]["history"][0]["pred_tier"] = 1.5
    assert "tiers_well_formed" in _failed(certify.audit(demo_doc))


def test_certificate_must_say_holds(demo_doc):
    demo_doc["events"][0]["certificate"]["holds"] = False  # every invariant still reads true
    assert _failed(certify.audit(demo_doc)) == {"certificates_consistent"}


@pytest.mark.parametrize("col", ["max_risk_estimate_log10", "miss_distance_m"])
def test_history_cdm_with_missing_input_needs_elevated(demo_doc, col):
    e = next(e for e in demo_doc["events"] if len(e["history"]) > 1 and e["history"][0]["pred_tier"] == Tier.SAFE)
    e["history"][0][col] = None
    out = certify.audit(demo_doc)
    assert out["status"] == "FAIL" and _failed(out) == {"every_cdm_respects_rule_floor"}
    e["history"][0]["pred_tier"] = int(Tier.ELEVATED)
    assert certify.audit(demo_doc)["status"] == "PASS"


def _post_raw(client, text: str):
    return client.post("/api/triage", content=text, headers={"content-type": "application/json"})


NON_FINITE_COLS = ("miss_distance", "max_risk_estimate", "c_sigma_r", "time_to_tca")


@pytest.mark.parametrize("token", ["Infinity", "-Infinity", "NaN"])
def test_triage_non_finite_numbers_are_missing_escalated_and_flagged(client, token):
    far = _one(miss_distance=20_000.0, max_risk_estimate=-8.0)  # Below threshold by every rule
    text = json.dumps({"cdms": [far | {c: "__X__"} for c in NON_FINITE_COLS]}).replace('"__X__"', token)
    r = _post_raw(client, text)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["non_finite_as_missing"] == [f"cdms[{i}].{c}" for i, c in enumerate(NON_FINITE_COLS)]
    for res, col in zip(body["results"], NON_FINITE_COLS, strict=True):
        assert res["needs_review"] and f"{col} missing" in res["certificate"]["input_flags"], col
        assert res["certificate"]["holds"] and res["certificate"]["decision"] == "not eligible"
    assert body["results"][0]["tier"] >= Tier.ELEVATED and body["results"][1]["tier"] >= Tier.ELEVATED


@pytest.mark.parametrize("token", ["inf", "-inf", "Infinity"])
def test_predict_file_reads_csv_inf_as_missing(cdm_csv, tmp_path, token):
    raw = pd.read_csv(cdm_csv)
    raw["miss_distance"] = raw["miss_distance"].astype(object)
    raw.loc[raw["event_id"] == 1, "miss_distance"] = token  # event 1 is otherwise far below threshold
    path = tmp_path / "inf.csv"
    raw.to_csv(path, index=False)
    out = predict_file(path)
    hit = out[(raw["event_id"] == 1).to_numpy()]
    assert (hit["pred_tier"] >= Tier.ELEVATED).all() and hit["needs_review"].all()
    assert (hit["baseline_tier"] >= Tier.ELEVATED).all()


@pytest.mark.parametrize(
    ("body", "status", "fragment"),
    [
        ({"cdms": [_one(event_id=-1)]}, 422, "event_id must be an integer from 0"),
        ({"cdms": [_one(event_id=2**64)]}, 422, "event_id must be an integer from 0"),
        ({"cdms": [_one(), 7]}, 422, "cdms[1] must be an object"),
        ({"cdms": [_one(note="x" * 1_000_001)]}, 413, "request body over"),
    ],
)
def test_triage_rejects_negative_ids_and_oversized_bodies(client, body, status, fragment):
    r = client.post("/api/triage", json=body)
    assert r.status_code == status and fragment in r.json()["detail"]


def test_triage_rejects_non_json_body(client):
    r = _post_raw(client, "not json")
    assert r.status_code == 422 and "body must be JSON" in r.json()["detail"]


def test_triage_row_cap_is_checked_before_rows_are_validated(client, monkeypatch):
    calls = []
    monkeypatch.setattr(server, "_rows_frame", lambda *a: calls.append(a))
    r = client.post("/api/triage", json={"cdms": [{"anything": 1}] * (server.MAX_TRIAGE_ROWS + 1)})
    assert r.status_code == 422 and "1-500" in r.json()["detail"] and not calls


INVALID_INPUTS = [
    ("c_sigma_r", 0.0, "c_sigma_r <= 0"),
    ("t_sigma_r", -3.0, "t_sigma_r <= 0"),
    ("time_to_tca", -0.5, "time_to_tca < 0 (after TCA)"),
    ("time_to_tca", None, "time_to_tca missing"),
    ("relative_speed", None, "relative_speed missing"),
    ("relative_position_n", None, "relative_position_n missing"),
]


@pytest.mark.parametrize(("col", "value", "flag"), INVALID_INPUTS)
def test_invalid_inputs_are_flagged_and_never_demoted(cdms, col, value, flag):
    df = cdms.copy()
    target = (df["event_id"] == 2).to_numpy()  # Elevated purely by the Pc upper bound, miss > 5 km
    assert (model.predict(df, demote_all(df)).loc[target, "pred_tier"] == Tier.SAFE).all()  # demoted when valid...
    df.loc[target, col] = np.nan if value is None else value
    out = model.predict_with_certificates(df, demote_all(df))
    hit = out[target]
    assert (hit["pred_tier"] >= Tier.ELEVATED).all() and hit["needs_review"].all()  # ...never with this input
    for c in hit["certificate"]:
        assert flag in c["input_flags"] and c["decision"] == "not eligible" and c["holds"]


@pytest.mark.parametrize(("col", "value", "flag"), INVALID_INPUTS)
def test_triage_flags_invalid_inputs(client, col, value, flag):
    row = _one(miss_distance=20_000.0, max_risk_estimate=-5.0) | {col: value}
    r = client.post("/api/triage", json={"cdms": [row]}).json()["results"][0]
    assert r["tier"] == Tier.ELEVATED and r["needs_review"] and flag in r["certificate"]["input_flags"]
