"""The backend's runner of docs/update-decision-fixtures.json: the update
decision shared with the cloud (src/lib/update-decision.test.ts) and the
Linux runtime (frameos/src/frameos/tests/test_update_decision.nim)."""

import json
from pathlib import Path

import pytest

from app.utils.update_decision import cohort_bucket, decide_update, parse_time, parse_version, rollout_percent

REPO = Path(__file__).resolve().parents[4]
FIXTURES = json.loads((REPO / "docs" / "update-decision-fixtures.json").read_text())
MANIFEST = json.loads((REPO / "docs" / "update-manifest.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["versions"], ids=lambda c: repr(c["input"]))
def test_parse_version(case):
    parsed = parse_version(case["input"])
    assert (f"{parsed[0]}.{parsed[1]}.{parsed[2]}" if parsed else None) == case["version"]


@pytest.mark.parametrize("case", FIXTURES["buckets"], ids=lambda c: f"{c['frameKey']}/{c['version']}")
def test_cohort_bucket(case):
    assert cohort_bucket(case["frameKey"], case["version"]) == case["bucket"]


@pytest.mark.parametrize("case", FIXTURES["rollout"], ids=lambda c: f"{c['release'].get('at')}@{c['now']}")
def test_rollout_percent(case):
    now = parse_time(case["now"])
    assert now is not None
    assert rollout_percent(case["release"], FIXTURES["defaultRollout"], now) == case["percent"]


@pytest.mark.parametrize("case", FIXTURES["decisions"], ids=lambda c: c["name"])
def test_decision(case):
    manifest = FIXTURES["manifests"][case["manifest"]] if case["manifest"] else None
    got = decide_update(manifest, case["request"])
    held = got["held"]
    assert {
        "version": got["version"],
        "reason": got["reason"],
        "latest": got["latest"],
        "held": {"version": held["version"], "why": held["why"]} if held else None,
    } == case["expect"]
    if held:
        assert isinstance(held["detail"], str) and held["detail"]


def test_the_published_manifest_reads():
    """docs/update-manifest.json is what every frame reads: each release
    parses, is listed once, in order, with a time, and nothing is paused by
    accident."""
    assert MANIFEST["version"] == 1
    versions = [parse_version(release["version"]) for release in MANIFEST["releases"]]
    assert all(versions), MANIFEST["releases"]
    assert versions == sorted(set(versions)), "releases are listed once each, oldest first"
    for release in MANIFEST["releases"]:
        assert parse_time(release["at"]) is not None, release
    assert MANIFEST.get("paused") in (None, "") or isinstance(MANIFEST["paused"], str)
    for stage in MANIFEST["defaultRollout"]:
        assert 0 <= stage["percent"] <= 100 and stage["afterHours"] >= 0
    assert MANIFEST["defaultRollout"][-1]["percent"] == 100, "a rollout that never finishes strands frames"
