import json
from datetime import datetime, timezone

from app.utils.tz_slice import canonical_zone, slice_changes, tz_slice, tz_slice_json

AUG_2026 = datetime(2026, 8, 22, tzinfo=timezone.utc).timestamp()


def test_brussels_slice_is_small_and_chrono_shaped():
    data = tz_slice("Europe/Brussels", AUG_2026)
    assert data is not None
    assert data["timezones"] == [{"id": 1, "name": "Europe/Brussels"}]
    changes = data["dstChanges"]
    # Starts with the offset in force on 2025-01-01 (CET), then alternates.
    assert changes[0]["name"] == "CET" and changes[0]["offset"] == 3600
    assert changes[0]["start"] <= datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp()
    assert changes[1]["name"] == "CEST" and changes[1]["offset"] == 7200
    assert all(c["tzId"] == 1 for c in changes)
    starts = [c["start"] for c in changes]
    assert starts == sorted(starts)
    assert len(json.dumps(data, separators=(",", ":"))) < 2048
    assert changes[-1]["start"] < datetime(2036, 1, 1, tzinfo=timezone.utc).timestamp()


def test_aliases_resolve_and_unknown_zones_give_nothing():
    assert canonical_zone("Europe/Kiev") == "Europe/Kyiv"
    # The slice carries the name the frame is configured with — chrono looks
    # the zone up by that name on the device — backed by Kyiv's transitions.
    kiev = tz_slice("Europe/Kiev", AUG_2026)
    assert kiev["timezones"][0]["name"] == "Europe/Kiev"
    assert kiev["dstChanges"] == tz_slice("Europe/Kyiv", AUG_2026)["dstChanges"]
    assert tz_slice("Mars/Olympus", AUG_2026) is None
    assert tz_slice("", AUG_2026) is None
    assert tz_slice_json("Mars/Olympus", AUG_2026) == ""


def test_slice_changes_keeps_the_offset_in_force_at_the_cut():
    changes = [
        {"start": 100.0, "name": "A", "offset": 0},
        {"start": 200.0, "name": "B", "offset": 3600},
        {"start": 300.0, "name": "C", "offset": 0},
    ]
    assert [c["name"] for c in slice_changes(changes, 250.0)] == ["B", "C"]
    assert [c["name"] for c in slice_changes(changes, 50.0)] == ["A", "B", "C"]
    assert [c["name"] for c in slice_changes(changes, 300.0)] == ["C"]


def test_zone_without_dst_has_one_change():
    data = tz_slice("Asia/Tokyo", AUG_2026)
    assert data is not None
    assert len(data["dstChanges"]) == 1
    assert data["dstChanges"][0]["offset"] == 32400
