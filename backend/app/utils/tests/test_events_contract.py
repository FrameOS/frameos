from __future__ import annotations

import json
from pathlib import Path

from app.codegen.scene_nim import get_events_schema
from app.utils.events_contract_gen import (
    DEVICE_COMMAND_EVENTS,
    REFUSED_BY_ORIGIN,
    SCENE_CHANGED_LOG_EVENTS,
)
from app.utils.frame_http import _is_control_path

# The backend's runner of docs/event-fixtures.json, the conformance corpus of
# the scene event contract (docs/events-contract.json, docs/events.md). The
# backend talks to a frame as `http:admin` when it has the serverApiKey and as
# `http:write` with the frame access key, so the part of the origin matrix it
# owns is "which event paths need the server key" (frame_http._is_control_path).
# That the generated module is current is test_esp32_events_contract.py's job.

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURES = json.loads((REPO_ROOT / "docs" / "event-fixtures.json").read_text())
CONTRACT = json.loads((REPO_ROOT / "docs" / "events-contract.json").read_text())


def test_origin_fixtures():
    cases = [case for case in FIXTURES["origins"]["cases"] if case["origin"] in REFUSED_BY_ORIGIN]
    assert len(cases) > 15
    for case in cases:
        refused = case["event"] in REFUSED_BY_ORIGIN[case["origin"]]
        assert refused == (not case["allowed"]), case


def test_control_paths_are_what_the_access_key_is_refused():
    for case in FIXTURES["origins"]["cases"]:
        if case["origin"] != "http:write":
            continue
        assert _is_control_path(f"/event/{case['event']}") == (not case["allowed"]), case
        assert _is_control_path(f"/event/{case['event']}?x=1") == (not case["allowed"]), case


def test_what_a_scene_is_refused_is_a_device_command_or_a_lifecycle_event():
    # A scene may not run the device, and it may not fake the runtime's own
    # `init` / `open` / `close` either. Anything else it is refused is a bug.
    lifecycle = {event["name"] for event in CONTRACT["events"] if event["class"] == "lifecycle"}
    assert REFUSED_BY_ORIGIN["scene"] <= DEVICE_COMMAND_EVENTS | lifecycle


def test_scene_changed_log_events_are_the_contracts():
    assert list(SCENE_CHANGED_LOG_EVENTS) == CONTRACT["logEvents"]["sceneChanged"]


def test_the_codegen_finds_the_catalog_from_any_working_directory(tmp_path, monkeypatch):
    """It used to be CWD-relative: a miss silently produced payload-less dispatch nodes."""
    monkeypatch.chdir(tmp_path)
    names = [event["name"] for event in get_events_schema()]
    assert names == [event["name"] for event in CONTRACT["events"] if event["listen"] or event["dispatch"]]
    assert "uploadScenes" not in names
