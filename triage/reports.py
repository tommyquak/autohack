"""Load the pipeline's report files (shared by the HTTP API in server.py and the copilot tools in tools.py).

Reads `reports/<name>` and falls back to the frozen full-test-set copy in `data/demo/` when `reports/` has none.
`REPORTS` / `DEMO` are read at call time, so tests can point them at a temp dir with monkeypatch.

    load_report("events.json")  -> parsed JSON (re-read only when the file's mtime changes)
    events_by_id()              -> {event_id: event}
    source()                    -> "reports" | "demo" | "missing": which copy events.json comes from
"""

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
DEMO = ROOT / "data" / "demo"  # frozen copy of the full-test-set reports, used when reports/ has none
BUILD_HINT = {
    "events.json": "uv run python -m triage.build_events",
    "metrics.json": "uv run python -m triage.evaluate",
}


class ReportMissing(FileNotFoundError):
    """Neither reports/ nor data/demo/ has the file; the message names the command that builds it."""

    def __init__(self, name: str):
        super().__init__(f"reports/{name} not found - run `{BUILD_HINT.get(name, 'the pipeline')}`")


def _locate(name: str) -> tuple[str, Path] | None:
    for label, folder in (("reports", REPORTS), ("demo", DEMO)):
        path = folder / name
        if path.exists():
            return label, path
    return None


def _stamp(name: str) -> tuple[Path, float]:
    found = _locate(name)
    if found is None:
        raise ReportMissing(name)
    path = found[1]
    return path, path.stat().st_mtime


# Keyed on (path, mtime): re-read only when the file changes, so a rebuild shows up without a restart.
@lru_cache(maxsize=4)
def _parse(path: Path, mtime: float) -> dict:
    return json.loads(path.read_text())


@lru_cache(maxsize=2)
def _index(path: Path, mtime: float) -> dict[int, dict]:
    return {e["event_id"]: e for e in _parse(path, mtime)["events"]}


def load_report(name: str) -> dict:
    return _parse(*_stamp(name))


def events_by_id() -> dict[int, dict]:
    return _index(*_stamp("events.json"))


_events_by_id = events_by_id  # old name from server.py


def source(name: str = "events.json") -> str:
    found = _locate(name)
    return found[0] if found else "missing"
