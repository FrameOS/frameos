"""What a person changed on the frame's own screen, adopted by this backend.

The settings panel's frame page (docs/scene-settings.md "The frame page") sets
the rotation, the render scale and what the frame's keys and swipes do (its
event map, the page's Buttons rows) on the device, and says so in one log line:
`{"event": "settings:frame", "origin": "panel", "rotate": 90, "renderScale":
1.5, "eventMap": [...], ...}` (the ESP32's fos_frame_settings.c, the Pi's
frame_settings_linux.nim). The row takes them, so the next deploy keeps what
the person chose, and so does the deploy baseline, so the drawer does not offer
to deploy what the frame already has. The cloud follows the hello's hardware
report instead (frames.ts `settingsWithReported`).

The Wi-Fi network is never in the line: no plane is told it.
"""
from __future__ import annotations

import math
from typing import Any

from app.models.frame import Frame, normalize_event_map
from app.utils.render_scale import MAX_RENDER_SCALE, normalize_render_scale

ROTATIONS = (0, 90, 180, 270)


def _rotation(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value in ROTATIONS else None


def _scale(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    scale = float(value)
    return scale if math.isfinite(scale) and 0.0 <= scale <= MAX_RENDER_SCALE else None


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
    # The whole map, as the frame now runs it. A row that never stored one
    # (the device's own map) takes it too: the person chose this one.
    event_map = log.get("eventMap")
    if isinstance(event_map, list):
        rules = normalize_event_map(event_map)
        if frame.event_map is None or rules != normalize_event_map(frame.event_map):
            changes["event_map"] = rules
    snapshot = frame.last_successful_deploy if isinstance(frame.last_successful_deploy, dict) else None
    if changes and snapshot:
        baseline = dict(snapshot)
        for key, value in changes.items():
            if key in baseline:
                baseline[key] = value
        if baseline != snapshot:
            changes["last_successful_deploy"] = baseline
    return changes
