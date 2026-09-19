"""The Python mirror of frameos/src/frameos/refresh_interval.nim (pinned there
by test_refresh_interval.nim) and frontend/src/utils/refreshInterval.ts."""

import math

from app.utils.refresh_interval import (
    REFRESH_INTERVAL_LABEL,
    parse_refresh_seconds,
    resolve_refresh_interval,
)


def test_parse_refresh_seconds():
    assert parse_refresh_seconds(60) == 60.0
    assert parse_refresh_seconds(0.5) == 0.5
    assert parse_refresh_seconds(" 90 ") == 90.0
    for bad in ("", "soon", 0, -5, math.nan, math.inf, "nan", "inf", None, True, {}, []):
        assert parse_refresh_seconds(bad) == 0.0


def test_implicit_field_is_appended_last():
    fields = [{"name": "search", "type": "string", "access": "public"}]
    resolved = resolve_refresh_interval(fields, 900)
    assert resolved.implicit
    assert resolved.key == "refreshInterval"
    assert resolved.default_seconds == 900.0
    assert [f["name"] for f in resolved.fields] == ["search", "refreshInterval"]
    assert resolved.fields[-1] == {
        "name": "refreshInterval",
        "label": REFRESH_INTERVAL_LABEL,
        "type": "float",
        "value": "900",
        "persist": "disk",
        "access": "public",
        "role": "refreshInterval",
    }
    assert len(fields) == 1  # the scene's own list is left alone


def test_missing_settings_fall_back_to_300():
    assert resolve_refresh_interval(None, None).default_seconds == 300.0
    assert resolve_refresh_interval([], "nonsense").default_seconds == 300.0


def test_named_field_is_taken_over_and_moved_last():
    resolved = resolve_refresh_interval(
        [{"name": "refreshInterval", "type": "float", "value": "120", "label": "Every"}, {"name": "search"}], 900
    )
    assert not resolved.implicit
    assert resolved.default_seconds == 120.0
    assert [f["name"] for f in resolved.fields] == ["search", "refreshInterval"]
    assert resolved.fields[-1]["label"] == "Every"


def test_role_beats_the_name():
    resolved = resolve_refresh_interval(
        [
            {"name": "refreshInterval", "type": "float", "value": "120"},
            {"name": "seconds", "type": "float", "value": "3600", "role": "refreshInterval"},
            {"name": "search"},
        ],
        900,
    )
    assert resolved.key == "seconds"
    assert resolved.default_seconds == 3600.0
    assert [f["name"] for f in resolved.fields] == ["refreshInterval", "search", "seconds"]


def test_empty_declared_default_uses_settings():
    resolved = resolve_refresh_interval([{"name": "seconds", "value": "", "role": "refreshInterval"}], 777)
    assert resolved.default_seconds == 777.0
