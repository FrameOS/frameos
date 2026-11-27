"""What every board's keys do (docs/buttons.md): one function makes each
hardware preset's event map, and the firmware's, the SPA's and the Linux
runtime's copies are generated from it."""

import json
import subprocess
import sys
from pathlib import Path

from app.tasks.embedded_firmware import (
    EMBEDDED_BOARD_KEYS,
    EMBEDDED_HARDWARE_PRESETS,
    embedded_preset_has_microphone,
)
from app.utils.button_standard import default_event_map

ROOT = Path(__file__).resolve().parents[4]
GENERATOR = ROOT / "frameos" / "tools" / "generate_board_keys.py"


def _map(preset_key: str) -> list[dict]:
    return EMBEDDED_HARDWARE_PRESETS[preset_key].get("eventMap") or []


def _emits(rules: list[dict], match: dict) -> str | None:
    for rule in rules:
        if rule["event"] == "button" and rule["match"] == match:
            return rule["emit"]
    return None


def test_the_generated_copies_are_current():
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_every_preset_lists_its_keys_and_takes_its_map_from_them():
    assert set(EMBEDDED_BOARD_KEYS) == set(EMBEDDED_HARDWARE_PRESETS)
    for key, preset in EMBEDDED_HARDWARE_PRESETS.items():
        keys = EMBEDDED_BOARD_KEYS[key]
        expected = default_event_map(keys, touch=bool(preset.get("touchPins")), mic=embedded_preset_has_microphone(preset))
        assert (preset.get("eventMap") or []) == expected, key
        labels = {k["label"] for k in keys}
        for button in preset.get("gpioButtons") or []:
            assert button["label"] in labels, f"{key}: {button['label']} has no role"
            assert button["role"], key
        assert len(json.dumps(preset.get("eventMap") or [], separators=(",", ":"))) <= 1023, key
        assert len(preset.get("eventMap") or []) <= 12, f"{key}: an ESP32 keeps twelve rules"


def test_no_double_or_triple_press_anywhere():
    for key, preset in EMBEDDED_HARDWARE_PRESETS.items():
        for rule in preset.get("eventMap") or []:
            assert rule["match"].get("action") not in ("doublePress", "triplePress"), key


def test_the_reterminals():
    e1001 = _map("seeed_reterminal_e1001")
    assert _emits(e1001, {"label": "REFRESH", "action": "longPress"}) == "voiceChat"
    assert _emits(e1001, {"role": "prev", "action": "longPress"}) == "setCurrentScene"
    assert _emits(e1001, {"role": "next", "action": "longPress"}) == "setCurrentScene"
    # No Back key: two keys held together are Back, and held the scene list.
    assert _emits(e1001, {"role": "back", "action": "press"}) == "back"
    assert _emits(e1001, {"role": "back", "action": "longPress"}) == "sceneSwitcher"
    # No microphone: the Action key held is the scene list.
    assert _emits(_map("seeed_reterminal_e1004"), {"label": "REFRESH", "action": "longPress"}) == "sceneSwitcher"
    assert any(rule["event"] == "edgeSwipe" for rule in _map("seeed_reterminal_e1003"))


def test_a_board_with_its_own_back_and_home_keys():
    crowpanel = _map("elecrow_crowpanel_5in79")
    assert _emits(crowpanel, {"label": "HOME", "action": "press"}) == "sceneSwitcher"
    assert _emits(crowpanel, {"label": "HOME", "action": "longPress"}) == "sceneSettings"
    assert _emits(crowpanel, {"label": "EXIT", "action": "press"}) == "back"
    assert _emits(crowpanel, {"label": "EXIT", "action": "longPress"}) == "sceneSwitcher"
    assert _emits(crowpanel, {"label": "OK", "action": "longPress"}) == "sceneSwitcher"
    # A Back key of its own: no Back by role, so two keys held together stay two keys.
    assert _emits(crowpanel, {"role": "back", "action": "press"}) is None


def test_the_screen_key_of_a_touch_lcd():
    indicator = _map("seeed_sensecap_indicator_d1")
    assert _emits(indicator, {"label": "BUTTON", "action": "press"}) == "toggleScreen"
    assert _emits(indicator, {"label": "BUTTON", "action": "longPress"}) == "sceneSwitcher"
    # The 2.8" has a microphone and no Action key: its Screen key held talks.
    assert _emits(_map("elecrow_crowpanel_advance_2in8"), {"label": "BOOT", "action": "longPress"}) == "voiceChat"
    # The watch talks with its crown (Action), so BOOT held is the scene list;
    # the crown's turns are presses alone and hold nothing.
    watch = _map("elecrow_crowpanel_watch_2in01")
    assert _emits(watch, {"label": "OK", "action": "longPress"}) == "voiceChat"
    assert _emits(watch, {"label": "BOOT", "action": "longPress"}) == "sceneSwitcher"
    assert _emits(watch, {"label": "HOME", "action": "press"}) == "sceneSwitcher"
    assert _emits(watch, {"role": "next", "action": "longPress"}) is None


def test_the_photopainter_and_one_key_boards():
    photopainter = _map("waveshare_esp32_s3_photopainter")
    assert _emits(photopainter, {"label": "KEY1", "action": "longPress"}) == "voiceChat"
    assert _emits(photopainter, {"role": "next", "action": "longPress"}) == "setCurrentScene"
    assert _map("trmnl_og") == [
        {"event": "button", "match": {"label": "BUTTON", "action": "longPress"}, "emit": "sceneSwitcher", "as": {}}
    ]
    assert _map("waveshare_esp32_s3_epaper_13_3e6") == [
        {"event": "button", "match": {"label": "BOOT", "action": "longPress"}, "emit": "voiceChat", "as": {}}
    ]


def test_the_inky_frame():
    inky = _map("pimoroni_inky_frame_7_3")
    assert _emits(inky, {"label": "D", "action": "press"}) == "back"
    assert _emits(inky, {"label": "E", "action": "press"}) == "sceneSwitcher"
    assert _emits(inky, {"label": "A", "action": "longPress"}) == "sceneSwitcher"
