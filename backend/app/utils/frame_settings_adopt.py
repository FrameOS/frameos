"""What a person changed on the frame's own screen, adopted by this backend.

The settings panel's frame page (docs/scene-settings.md "The frame page") sets
the rotation and the render scale on the device, and says so in one log line:
`{"event": "settings:frame", "origin": "panel", "rotate": 90, "renderScale":
1.5, ...}` (the ESP32's fos_frame_settings.c, the Pi's
frame_settings_linux.nim), and on a board that has them the sounds of a tap
and a press (`clickSounds`, the row's device_config) and, on one that deep-sleeps, how long a
tap keeps it up (`awakeAfterInputSeconds`, device_config too) and, where the glass can dim, its
`brightness` (device_config too). The row takes them, so the next deploy keeps what
the person chose, and so does the deploy baseline, so the drawer does not offer
to deploy what the frame already has. The cloud follows the hello's hardware
report instead (frames.ts `settingsWithReported`).

The Wi-Fi network is never in the line: no plane is told it.
"""
from __future__ import annotations

import math
from typing import Any

from app.models.frame import Frame
from app.utils.render_scale import MAX_RENDER_SCALE, normalize_render_scale

ROTATIONS = (0, 90, 180, 270)
CLICK_SOUNDS = ("silent", "normal")  # embedded_firmware.EMBEDDED_CLICK_SOUNDS
AWAKE_AFTER_INPUT_DEFAULT = 300  # the firmware's FRAMEOS_DEFAULT_AWAKE_AFTER_INPUT_SEC
AWAKE_AFTER_INPUT_MAX = 3600  # docs/cloud-frames-contract.json awake_after_input_seconds
BRIGHTNESS_DEFAULT = 100  # docs/cloud-frames-contract.json brightness (5..100)


def _rotation(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value in ROTATIONS else None


def _scale(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    scale = float(value)
    return scale if math.isfinite(scale) and 0.0 <= scale <= MAX_RENDER_SCALE else None


def _seconds_awake(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= AWAKE_AFTER_INPUT_MAX else None


def panel_settings_changes(frame: Frame, log: dict[str, Any]) -> dict[str, Any]:
    """The row changes a `settings:frame` line from the frame page asks for."""
    if log.get("event") != "settings:frame" or log.get("origin") != "panel":
        return {}
    changes: dict[str, Any] = {}
    rotate = _rotation(log.get("rotate"))
    if rotate is not None and rotate != (frame.rotate or 0):
        changes["rotate"] = rotate
    scale = _scale(log.get("renderScale"))
    if scale is not None and scale != normalize_render_scale(frame.render_scale):
        changes["render_scale"] = scale
    device_config = frame.device_config if isinstance(frame.device_config, dict) else {}
    config = dict(device_config)
    sounds = log.get("clickSounds")
    held = device_config.get("clickSounds", device_config.get("click_sounds"))
    if isinstance(sounds, str) and sounds in CLICK_SOUNDS and sounds != (held or "normal"):
        config.pop("click_sounds", None)
        config["clickSounds"] = sounds
    awake = _seconds_awake(log.get("awakeAfterInputSeconds"))
    held_awake = _seconds_awake(device_config.get("awakeAfterInputSeconds",
                                                  device_config.get("awake_after_input_seconds")))
    if awake is not None and awake != (AWAKE_AFTER_INPUT_DEFAULT if held_awake is None else held_awake):
        config.pop("awake_after_input_seconds", None)
        config["awakeAfterInputSeconds"] = awake
    bright = log.get("brightness")
    held_bright = device_config.get("brightness")
    if (isinstance(bright, int) and not isinstance(bright, bool) and 5 <= bright <= 100
            and bright != (held_bright if isinstance(held_bright, int) else BRIGHTNESS_DEFAULT)):
        config["brightness"] = bright
    if config != device_config:
        changes["device_config"] = config
    snapshot = frame.last_successful_deploy if isinstance(frame.last_successful_deploy, dict) else None
    if changes and snapshot:
        baseline = dict(snapshot)
        for key, value in changes.items():
            if key in baseline:
                baseline[key] = value
        if baseline != snapshot:
            changes["last_successful_deploy"] = baseline
    return changes
