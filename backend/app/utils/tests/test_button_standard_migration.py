"""The d1b5e7a9c3f2 data migration: a frame whose stored event map is still
the map its hardware preset seeded before the button standard
(docs/buttons.md) gets the preset's new map; a map anyone changed stays,
and so does an old map whose new one an ESP32 before 2026.11.15 could not
hold (more than eight rules)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.tasks.embedded_firmware import EMBEDDED_HARDWARE_PRESETS

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = ROOT / "backend" / "migrations" / "versions" / "d1b5e7a9c3f2_button_standard_event_maps.py"

# Every preset that had a map before the standard.
PRESETS_WITH_AN_OLD_MAP = {
    "elecrow_crowpanel_5in79",
    "elecrow_crowpanel_advance_2in8",
    "elecrow_crowpanel_advance_7",
    "elecrow_crowpanel_epd_4in2",
    "elecrow_crowpanel_rotary_1in46",
    "elecrow_crowpanel_watch_2in01",
    "guition_esp32_4848s040",
    "seeed_reterminal_e1001",
    "seeed_reterminal_e1002",
    "seeed_reterminal_e1003",
    "seeed_reterminal_e1004",
    "seeed_reterminal_sticky",
    "seeed_sensecap_indicator_d1",
    "sunton_esp32_8048s070",
    "waveshare_esp32_s3_epaper_13_3e6",
    "waveshare_esp32_s3_photopainter",
    "waveshare_esp32_s3_touch_amoled_1_75",
}


def _load_migration():
    spec = importlib.util.spec_from_file_location("button_standard_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


migration = _load_migration()


def _new_map(preset: str) -> list[dict]:
    return EMBEDDED_HARDWARE_PRESETS[preset]["eventMap"]


def test_the_old_maps_are_frozen_for_every_preset_that_had_one():
    assert set(migration.OLD_PRESET_MAPS) == PRESETS_WITH_AN_OLD_MAP
    for preset, rules in migration.OLD_PRESET_MAPS.items():
        assert preset in EMBEDDED_HARDWARE_PRESETS, preset
        assert isinstance(rules, list) and rules, preset
        assert all(isinstance(rule, dict) and rule.get("event") and rule.get("emit") for rule in rules), preset
    # The maps as they were, not as they are: the one-key LCDs' double press,
    # the reTerminal's arrows by label.
    assert {"label": "BUTTON", "action": "doublePress"} in [
        rule["match"] for rule in migration.OLD_PRESET_MAPS["seeed_sensecap_indicator_d1"]
    ]
    assert migration.OLD_PRESET_MAPS["seeed_reterminal_e1004"] == [
        {"event": "button", "match": {"label": "LEFT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "prev"}},
        {"event": "button", "match": {"label": "RIGHT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "next"}},
    ]


def test_runs_at_least_reads_the_last_deploy_s_version():
    assert migration._runs_at_least({"frameos_version": "2026.11.15"}, "2026.11.15")
    assert migration._runs_at_least({"frameos_version": "2026.11.20+abc123"}, "2026.11.15")
    assert migration._runs_at_least({"frameos_version": "2026.12.1"}, "2026.11.15")
    assert migration._runs_at_least({"frameos_version": "2027.1.0"}, "2026.11.15")
    assert migration._runs_at_least(json.dumps({"frameos_version": "2026.11.16"}), "2026.11.15")
    assert not migration._runs_at_least({"frameos_version": "2026.11.14"}, "2026.11.15")
    assert not migration._runs_at_least({"frameos_version": "2026.9.13"}, "2026.11.15")
    assert not migration._runs_at_least({"frameos_version": "2026.11"}, "2026.11.15")
    # Not known is not new enough.
    for unknown in (None, "", "not json", {}, {"frameos_version": ""}, {"frameos_version": "dev"}, [], {"name": "x"}):
        assert not migration._runs_at_least(unknown, "2026.11.15"), unknown


def _frames(rows: list[dict]) -> dict[int, object]:
    """Run upgrade() through alembic's `op` against a SQLite `frame` table
    holding these rows, and hand back every row's event map after it."""
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE frame (id INTEGER PRIMARY KEY, embedded JSON, device_config JSON,"
                " event_map JSON, last_successful_deploy JSON)"
            )
        )
        for row in rows:
            connection.execute(
                sa.text(
                    "INSERT INTO frame (id, embedded, device_config, event_map, last_successful_deploy)"
                    " VALUES (:id, :embedded, :device_config, :event_map, :last_successful_deploy)"
                ),
                {
                    "id": row["id"],
                    **{
                        key: None if row.get(key) is None else json.dumps(row[key])
                        for key in ("embedded", "device_config", "event_map", "last_successful_deploy")
                    },
                },
            )
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
        stored = connection.execute(sa.text("SELECT id, event_map FROM frame ORDER BY id")).fetchall()
    return {row.id: None if row.event_map is None else json.loads(row.event_map) for row in stored}


def test_upgrade_gives_a_seeded_map_the_new_one_and_keeps_what_anyone_changed():
    e1001_old = migration.OLD_PRESET_MAPS["seeed_reterminal_e1001"]
    e1003_old = migration.OLD_PRESET_MAPS["seeed_reterminal_e1003"]
    changed = [dict(rule) for rule in e1001_old[:-1]]
    assert len(e1003_old) == 7 and len(_new_map("seeed_reterminal_e1003")) == 9

    after = _frames([
        # Still the preset's old map: the new one.
        {"id": 1, "embedded": {"hardwarePreset": "seeed_reterminal_e1001"}, "event_map": e1001_old},
        # A map the owner changed, and one the owner cleared: theirs.
        {"id": 2, "embedded": {"hardwarePreset": "seeed_reterminal_e1001"}, "event_map": changed},
        {"id": 3, "embedded": {"hardwarePreset": "seeed_reterminal_e1001"}, "event_map": []},
        # Never set: stays NULL (the preset seeds it on the next save).
        {"id": 4, "embedded": {"hardwarePreset": "seeed_reterminal_e1001"}, "event_map": None},
        # Seven rules that become nine, on a frame not known to run
        # 2026.11.15: an older ESP32 would refuse the ninth, so the old map stays.
        {"id": 5, "embedded": {"hardwarePreset": "seeed_reterminal_e1003"}, "event_map": e1003_old},
        {"id": 6, "embedded": {"hardwarePreset": "seeed_reterminal_e1003"}, "event_map": e1003_old,
         "last_successful_deploy": {"frameos_version": "2026.11.14"}},
        # ... and one known to run it gets the new map.
        {"id": 7, "embedded": {"hardwarePreset": "seeed_reterminal_e1003"}, "event_map": e1003_old,
         "last_successful_deploy": {"frameos_version": "2026.11.15"}},
        # The preset read as embedded_firmware.py reads it: device_config's
        # spelling, dashes and case.
        {"id": 8, "device_config": {"hardware_preset": "Seeed-Reterminal-E1004"},
         "event_map": migration.OLD_PRESET_MAPS["seeed_reterminal_e1004"]},
        # Another preset's old map is not this preset's.
        {"id": 9, "embedded": {"hardwarePreset": "seeed_reterminal_e1004"}, "event_map": e1001_old},
        # A board that had no map before, and a frame with no preset at all.
        {"id": 10, "embedded": {"hardwarePreset": "trmnl_og"}, "event_map": e1001_old},
        {"id": 11, "embedded": {}, "event_map": e1001_old},
    ])

    assert after[1] == _new_map("seeed_reterminal_e1001")
    assert after[2] == changed
    assert after[3] == []
    assert after[4] is None
    assert after[5] == e1003_old
    assert after[6] == e1003_old
    assert after[7] == _new_map("seeed_reterminal_e1003")
    assert after[8] == _new_map("seeed_reterminal_e1004")
    assert after[9] == e1001_old
    assert after[10] == e1001_old
    assert after[11] == e1001_old


def test_upgrade_moves_a_short_map_on_whatever_the_frame_runs():
    # Old firmware holds eight rules: a new map within that needs no version,
    # and neither does one that was already over it (the Sticky's nine).
    rows = []
    expected = {}
    for index, preset in enumerate(sorted(PRESETS_WITH_AN_OLD_MAP), start=1):
        old = migration.OLD_PRESET_MAPS[preset]
        new = _new_map(preset)
        rows.append({"id": index, "embedded": {"hardwarePreset": preset}, "event_map": old})
        gated = len(new) > migration.ESP32_RULES_BEFORE_2026_11_15 >= len(old)
        expected[index] = old if gated else new
    after = _frames(rows)
    assert after == expected
    # Which boards wait for a newer firmware: those whose map grows past eight.
    waiting = {preset for index, preset in enumerate(sorted(PRESETS_WITH_AN_OLD_MAP), start=1) if after[index] != _new_map(preset)}
    assert waiting == {
        "elecrow_crowpanel_rotary_1in46",
        "elecrow_crowpanel_watch_2in01",
        "seeed_reterminal_e1003",
        "waveshare_esp32_s3_touch_amoled_1_75",
    }
