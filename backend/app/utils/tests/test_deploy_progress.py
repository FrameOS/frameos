"""The deploy-progress fold against the contract's conformance corpus
(docs/deploy-progress-fixtures.json). The cloud's lib/deploy-progress.ts
replays the same file; a case that passes here and fails there (or the
other way round) is the two planes drifting."""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.utils import deploy_progress as dp

REPO = Path(__file__).resolve().parents[4]
FIXTURES = REPO / "docs" / "deploy-progress-fixtures.json"
GENERATOR = REPO / "frameos" / "tools" / "generate_deploy_progress_contract.py"

NOW = datetime(2026, 10, 12, 12, 0, 0, tzinfo=timezone.utc)


def load_fixtures() -> dict:
    return json.loads(FIXTURES.read_text())


def test_generated_tables_are_current():
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _apply(record: dict, step: dict, now: datetime) -> dict | None:
    if "advance" in step:
        return dp.advance(record, step["advance"], now=now, detail=step.get("detail"))
    if "signal" in step:
        return dp.fold(record, step["signal"], now=now, detail=step.get("detail"))
    if "log" in step:
        return dp.fold_log(record, step["log"], now=now)
    if "command" in step:
        command = step["command"]
        return dp.fold_command(record, command["type"], command["state"], now=now, error=command.get("error"))
    if "finish" in step:
        return dp.finish(record, now=now, detail=step.get("detail"))
    if "fail" in step:
        return dp.fail(record, step["fail"], now=now)
    return None


@pytest.mark.parametrize("case", load_fixtures()["cases"], ids=lambda case: case["name"])
def test_fixture_case(case: dict):
    start = case.get("start") or {}
    record = dp.start(case["kind"], deploy_id="fixture", now=NOW, stage=start.get("stage"))
    now = NOW
    for index, step in enumerate(case["steps"]):
        now = now + timedelta(seconds=1)
        moved = _apply(record, step, now)
        expect = step.get("expect") or {}
        where = f"{case['name']} step {index}"
        if expect.get("changed") is False:
            assert moved is None, f"{where}: expected no change, got {moved}"
        elif any(key in step for key in ("advance", "signal", "log", "command", "finish", "fail")):
            assert moved is not None, f"{where}: expected a change"
        if moved is not None:
            record = moved
        for key in ("stage", "status", "detail", "error", "progress"):
            if key in expect and key != "changed":
                assert record.get(key) == expect[key], f"{where}: {key}={record.get(key)!r}, expected {expect[key]!r}"


@pytest.mark.parametrize("case", load_fixtures()["stale"], ids=lambda case: f"{case['kind']}:{case['stage']}:{case['ageSeconds']}")
def test_fixture_stale(case: dict):
    record: dict | None = dp.start(case["kind"], deploy_id="fixture", now=NOW, stage=case["stage"])
    if case.get("status") == "done":
        record = dp.finish(record, now=NOW)
    elif case.get("status") == "error":
        record = dp.fail(record, "boom", now=NOW)
    now = NOW + timedelta(seconds=case["ageSeconds"])
    wake = None
    if "nextWakeInSeconds" in case:
        wake = now + timedelta(seconds=case["nextWakeInSeconds"])
    assert dp.is_stale(record, now, next_wake_at=wake) is case["expect"]


@pytest.mark.parametrize("case", load_fixtures()["percent"], ids=lambda case: f"{case['kind']}:{case['stage']}")
def test_fixture_percent(case: dict):
    if case.get("status") == "done":
        record = dp.finish(dp.start(case["kind"], deploy_id="fixture", now=NOW), now=NOW)
    else:
        record = dp.start(case["kind"], deploy_id="fixture", now=NOW, stage=case["stage"])
        if case.get("progress"):
            record = {**record, "progress": case["progress"]}
    assert dp.percent(record) == case["expect"]


def test_start_rejects_unknown_kind_and_stage():
    with pytest.raises(ValueError):
        dp.start("nope", deploy_id="x", now=NOW)
    with pytest.raises(ValueError):
        dp.start("virtual", deploy_id="x", now=NOW, stage="building")


def test_advance_with_kind_guard_leaves_other_kinds_alone():
    record = dp.start("restart", deploy_id="x", now=NOW)
    assert dp.advance(record, "restarting", now=NOW, kind="reboot") is None
    assert dp.advance(record, "restarting", now=NOW, kind="restart")["stage"] == "restarting"


def test_note_refreshes_caption_and_timestamp_only():
    record = dp.start("linux_full", deploy_id="x", now=NOW, stage="building")
    later = NOW + timedelta(seconds=30)
    noted = dp.note(record, "cross-compiling", now=later)
    assert noted["stage"] == "building"
    assert noted["detail"] == "cross-compiling"
    assert noted["at"] == later.isoformat()
    assert noted["started_at"] == NOW.isoformat()


def test_is_record_rejects_garbage():
    assert not dp.is_record(None)
    assert not dp.is_record({"kind": "linux_full"})
    assert not dp.is_record({"kind": "nope", "stage": "queued", "status": "running"})
    assert dp.is_record(dp.start("virtual", deploy_id="x", now=NOW))
