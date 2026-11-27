"""frames: the button standard's event maps (docs/buttons.md)

Revision ID: d1b5e7a9c3f2
Revises: b6d8f0a2c4e6
Create Date: 2026-11-27 03:00:00.000000

Every hardware preset's event map is made by one function now
(app/utils/button_standard.py): no double or triple press, Back held and an
Action key held without a microphone are the scene list, two keys held
together are Back on a board without a Back key, and the arrows held walk
the scenes by role. A frame whose stored map is still its preset's map as
it was seeded (OLD_PRESET_MAPS: the maps before this change, frozen here)
gets the new one. A map anyone changed stays as it is.

An ESP32 before 2026.11.15 keeps eight rules at most and refuses a whole
settings push with a ninth: a frame not known to run 2026.11.15 or newer
keeps its old map where the new one is longer than that (the owner resets
it under Settings > Button actions after updating).
"""
import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd1b5e7a9c3f2'
down_revision = 'b6d8f0a2c4e6'
branch_labels = None
depends_on = None


PRESET_KEYS = ("hardwarePreset", "hardware_preset", "boardPreset", "board_preset")
ESP32_RULES_BEFORE_2026_11_15 = 8

OLD_PRESET_MAPS = {
    "elecrow_crowpanel_5in79": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"HOME\",\"action\":\"press\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"HOME\",\"action\":\"longPress\"},\"emit\":\"sceneSettings\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"EXIT\",\"action\":\"press\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"PREV\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"NEXT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}]"),
    "elecrow_crowpanel_advance_2in8": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "elecrow_crowpanel_advance_7": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "elecrow_crowpanel_epd_4in2": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"HOME\",\"action\":\"press\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"HOME\",\"action\":\"longPress\"},\"emit\":\"sceneSettings\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"EXIT\",\"action\":\"press\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"PREV\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"NEXT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}]"),
    "elecrow_crowpanel_rotary_1in46": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "elecrow_crowpanel_watch_2in01": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"HOME\",\"action\":\"press\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"OK\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "guition_esp32_4848s040": json.loads("[{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "seeed_reterminal_e1001": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}},{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}}]"),
    "seeed_reterminal_e1002": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}},{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}}]"),
    "seeed_reterminal_e1003": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}},{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "seeed_reterminal_e1004": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}]"),
    "seeed_reterminal_sticky": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"UP\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},{\"event\":\"button\",\"match\":{\"label\":\"DOWN\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}},{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"doublePress\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"triplePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "seeed_sensecap_indicator_d1": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BUTTON\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BUTTON\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "sunton_esp32_8048s070": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
    "waveshare_esp32_s3_epaper_13_3e6": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}}]"),
    "waveshare_esp32_s3_photopainter": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"KEY1\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}}]"),
    "waveshare_esp32_s3_touch_amoled_1_75": json.loads("[{\"event\":\"button\",\"match\":{\"label\":\"PWR\",\"action\":\"press\"},\"emit\":\"toggleScreen\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"PWR\",\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"button\",\"match\":{\"label\":\"BOOT\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"},\"emit\":\"forward\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"},\"emit\":\"back\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}},{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]"),
}


def _json(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _preset_of(*sources) -> str:
    """The frame's embedded hardware preset, the way embedded_firmware.py reads it."""
    for source in sources:
        source = _json(source)
        if isinstance(source, dict):
            for key in PRESET_KEYS:
                if key in source:
                    return str(source.get(key) or "").strip().replace("-", "_").replace(".", "_").lower()
    return ""


def _runs_at_least(deploy, version: str) -> bool:
    deployed = _json(deploy)
    seen = str((deployed or {}).get("frameos_version") or "") if isinstance(deployed, dict) else ""
    parts = seen.split("+")[0].split(".")
    want = version.split(".")
    try:
        return [int(p) for p in parts[:3]] >= [int(w) for w in want]
    except ValueError:
        return False


def upgrade():
    from app.tasks.embedded_firmware import EMBEDDED_HARDWARE_PRESETS

    connection = op.get_bind()
    table = sa.Table(
        "frame",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("embedded", sa.JSON()),
        sa.Column("device_config", sa.JSON()),
        sa.Column("event_map", sa.JSON()),
        sa.Column("last_successful_deploy", sa.JSON()),
    )
    rows = connection.execute(
        sa.select(table.c.id, table.c.embedded, table.c.device_config, table.c.event_map, table.c.last_successful_deploy)
    ).fetchall()
    for row in rows:
        key = _preset_of(row.embedded, row.device_config)
        old = OLD_PRESET_MAPS.get(key)
        stored = _json(row.event_map)
        if old is None or stored != old:
            continue
        new = (EMBEDDED_HARDWARE_PRESETS.get(key) or {}).get("eventMap") or []
        if len(new) > ESP32_RULES_BEFORE_2026_11_15 >= len(old) and not _runs_at_least(
            row.last_successful_deploy, "2026.11.15"
        ):
            continue
        connection.execute(table.update().where(table.c.id == row.id).values(event_map=json.loads(json.dumps(new))))


def downgrade():
    # The new maps are the presets' own from here on; nothing to put back.
    pass
