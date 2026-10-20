"""What a provider frame is sent: the backend's frame row as contract verbs.

A deploy to a frame on its management socket is three verbs
(docs/cloud-frames.md): `set_settings` (the contract's allowlisted keys,
gated on the firmware the device reports and checked by the contract
walker), `set_schedule` (the schedule with its `disabled` flags resolved,
the way the cloud's scheduleDevicePayload does) and `set_scenes` (the
interpreted scenes, with a checksum the device echoes in its `scene_ack`).

The settings half is the SPA's cloudFrameSettingsPayload
(frontend/src/utils/cloudFrameSettings.ts) in Python: the backend's frame
row and the SPA's frame form are the same model.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from app.models.frame import Frame, normalize_error_behavior, normalize_input_settings
from app.utils.cloud_frames_contract import (
    check_contract_settings,
    contract_setting_keys,
    contract_setting_since,
)
from app.utils.events_contract_gen import BUTTON_ROLES, DEFAULT_KEYBOARD_LAYOUT, KEYBOARD_LAYOUTS
from app.utils.provider_frames import provider_profile, provider_reported_version
from app.utils.retired_apps import scenes_for_embedded_runtime
from app.utils.scene_execution import scene_is_interpreted
from app.utils.versions import version_tuple

# A gpio button `role` is a Linux item key from the input batch on; firmware
# between 2026.8.31 and it refuses the whole push on the key.
GPIO_BUTTON_ROLES_SINCE = "2026.9.23"
CONTROL_CODE_POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right", "center")
# The device's schedule engine caps (the ESP32's fos_schedule.c is the smallest).
MAX_SCHEDULE_EVENTS = 64
MAX_SCHEDULE_EVENT_PAYLOAD_BYTES = 4 * 1024

# ESP32 power keys live in the backend's device_config, under either spelling.
_ESP32_DEVICE_CONFIG_KEYS: dict[str, tuple[str, str]] = {
    "deep_sleep": ("deepSleep", "deep_sleep"),
    "deep_sleep_on_battery": ("deepSleepOnBattery", "deep_sleep_on_battery"),
    "wake_check_seconds": ("wakeCheckSeconds", "wake_check_seconds"),
    "battery_pin": ("batteryPin", "battery_pin"),
    "battery_divider": ("batteryDivider", "battery_divider"),
    "battery_enable_pin": ("batteryEnablePin", "battery_enable_pin"),
    "buzzer_pin": ("buzzerPin", "buzzer_pin"),
    "buzzer_tone_hz": ("buzzerToneHz", "buzzer_tone_hz"),
}


def supports_since(since: Optional[str], version: Optional[str]) -> bool:
    """Does firmware `version` know a key that arrived in `since`? A device
    that never reported a version gets only the base set."""
    if since is None:
        return True
    have = version_tuple(version)
    need = version_tuple(since)
    return have is not None and need is not None and have >= need


def _number(value: Any) -> Optional[float | int]:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _integer(value: Any) -> Optional[int]:
    parsed = _number(value)
    return None if parsed is None else int(parsed)


def _is_hex_color(value: Any) -> bool:
    import re

    return isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) is not None


def _control_code(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    enabled = value.get("enabled")
    if enabled not in (None, ""):
        out["enabled"] = enabled is True or enabled == "true"
    if value.get("position") in CONTROL_CODE_POSITIONS:
        out["position"] = value["position"]
    size = _number(value.get("size"))
    if size is not None:
        out["size"] = size
    for key in ("padding", "offsetX", "offsetY"):
        parsed = _integer(value.get(key))
        if parsed is not None:
            out[key] = parsed
    for key in ("qrCodeColor", "backgroundColor"):
        if _is_hex_color(value.get(key)):
            out[key] = value[key]
    return out or None


def _error_behavior(value: Any) -> Optional[dict[str, Any]]:
    form = normalize_error_behavior(value)
    if not isinstance(form, dict):
        return None
    out: dict[str, Any] = {}
    if form.get("mode") in ("safe_mode", "show_error_retry", "silent_retry"):
        out["mode"] = form["mode"]
    if isinstance(form.get("silent_retry_forever"), bool):
        out["silent_retry_forever"] = form["silent_retry_forever"]
    for key in ("retry_seconds", "silent_retry_seconds", "silent_window_minutes", "show_error_retry_seconds"):
        parsed = _number(form.get(key))
        if parsed is not None and parsed > 0:
            out[key] = parsed
    return out or None


def _timezone_updater(value: Any) -> Optional[dict[str, Any]]:
    # enabled + hour only: a provider never points a frame's tz download anywhere.
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {"enabled": value.get("enabled") is not False}
    hour = _integer(value.get("hour"))
    if hour is not None and 0 <= hour <= 23:
        out["hour"] = hour
    return out


def _save_assets(value: Any) -> Optional[bool | dict[str, bool]]:
    if isinstance(value, bool):
        return value
    if not isinstance(value, dict):
        return None
    return {
        key: flag
        for key, flag in value.items()
        if isinstance(key, str) and 0 < len(key) <= 64 and isinstance(flag, bool)
    }


def _palette(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or not isinstance(value.get("colors"), list):
        return None
    colors = value["colors"]
    if not all(_is_hex_color(color) for color in colors):
        return None
    out: dict[str, Any] = {"colors": list(colors)}
    name = value.get("name")
    if isinstance(name, str) and 0 < len(name) <= 64:
        out["name"] = name
    names = value.get("colorNames")
    if isinstance(names, list) and len(names) == len(colors) and all(isinstance(n, str) and len(n) <= 32 for n in names):
        out["colorNames"] = list(names)
    return out


def _partial_refresh(value: Any) -> Optional[dict[str, Any]]:
    # Only the partial-refresh policy: pins, VCOM and upload URLs are the device's own.
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    if value.get("partial") not in (None, ""):
        out["partial"] = value["partial"] is True or value["partial"] == "true"
    area = _number(value.get("partialMaxAreaPercent"))
    if area is not None and 0 <= area <= 100:
        out["partialMaxAreaPercent"] = area
    refreshes = _integer(value.get("partialMaxRefreshesBeforeFull"))
    if refreshes is not None and refreshes >= 0:
        out["partialMaxRefreshesBeforeFull"] = refreshes
    return out or None


def _gpio_buttons(value: Any, *, roles: bool) -> Optional[list[dict[str, Any]]]:
    if not isinstance(value, list):
        return None
    out: list[dict[str, Any]] = []
    pins: set[int] = set()
    for row in value:
        if not isinstance(row, dict):
            continue
        pin = row.get("pin")
        if pin is None or pin == "":
            continue
        parsed = _integer(pin)
        raw_label = row.get("label")
        label = raw_label.strip() if isinstance(raw_label, str) else ""
        if parsed is None or parsed < 0 or not label or len(label) > 32 or parsed in pins:
            return None
        pins.add(parsed)
        button: dict[str, Any] = {"pin": parsed, "label": label}
        if roles and row.get("role") in BUTTON_ROLES:
            button["role"] = row["role"]
        out.append(button)
    return out


def _input_settings(value: Any) -> dict[str, Any]:
    form = normalize_input_settings(value)
    layout = form.get("keyboardLayout") if isinstance(form, dict) else None
    grab = form.get("grabKeyboard") if isinstance(form, dict) else None
    return {
        "keyboardLayout": layout if layout in KEYBOARD_LAYOUTS else DEFAULT_KEYBOARD_LAYOUT,
        "grabKeyboard": grab is True or grab == "true",
    }


def _device_config_value(frame: Frame, names: tuple[str, str]) -> Any:
    config = frame.device_config if isinstance(frame.device_config, dict) else {}
    for name in names:
        if name in config:
            return config[name]
    return None


def _setting_value(frame: Frame, key: str, *, roles: bool) -> Any:
    """The frame's value for wire key `key`, in the device's shape, or None
    when the frame holds nothing to send for it."""
    if key == "name":
        return frame.name or None
    if key in ("rotate", "metrics_interval", "max_http_response_bytes"):
        return _integer(getattr(frame, key, None)) if key != "metrics_interval" else _number(frame.metrics_interval)
    if key == "interval":
        return _number(frame.interval)
    if key == "scaling_mode":
        return frame.scaling_mode or None
    if key == "timezone":
        return frame.timezone or None
    if key == "debug":
        return frame.debug if isinstance(frame.debug, bool) else None
    if key == "flip":
        return frame.flip if isinstance(frame.flip, str) else None
    if key == "error_behavior":
        return _error_behavior(frame.error_behavior)
    if key == "control_code":
        return _control_code(frame.control_code)
    if key == "save_assets":
        return _save_assets(frame.save_assets)
    if key == "timezone_updater":
        return _timezone_updater(frame.timezone_updater)
    if key == "palette":
        return _palette(frame.palette)
    if key == "colors":
        return frame.colors if isinstance(frame.colors, dict) else None
    if key == "device_config":
        return _partial_refresh(frame.device_config)
    if key == "gpio_buttons":
        return _gpio_buttons(frame.gpio_buttons, roles=roles)
    if key == "device":
        return frame.device or None
    if key == "input_settings":
        return _input_settings(frame.input_settings)
    if key in _ESP32_DEVICE_CONFIG_KEYS:
        raw = _device_config_value(frame, _ESP32_DEVICE_CONFIG_KEYS[key])
        if key.startswith("deep_sleep"):
            return raw if isinstance(raw, bool) else None
        return _number(raw)
    return None


def provider_settings_payload(frame: Frame) -> dict[str, Any]:
    """The `set_settings` object for this frame: every contract key its
    profile takes and its firmware knows, that the frame holds a value for
    and that passes the key's rule. A key that would fail is left out rather
    than sent — one refused key refuses the whole push on the device."""
    from app.utils.cloud_frames_contract import validate_contract_setting

    profile = provider_profile(frame)
    version = provider_reported_version(frame)
    roles = profile == "linux" and supports_since(GPIO_BUTTON_ROLES_SINCE, version)
    settings: dict[str, Any] = {}
    for key in contract_setting_keys(profile):
        if not supports_since(contract_setting_since(key, profile), version):
            continue
        value = _setting_value(frame, key, roles=roles)
        if value is None:
            continue
        if validate_contract_setting(key, value, profile):
            settings[key] = value
    if profile == "esp32" and isinstance(settings.get("timezone"), str):
        from app.utils.tz_slice import tz_slice

        if supports_since(contract_setting_since("timezone_data", "esp32"), version):
            data = tz_slice(settings["timezone"])
            if data:
                settings["timezone_data"] = data
    if check_contract_settings(settings, profile) is not None:
        # Unreachable with per-key validation; a belt for the whole-push rules.
        settings = {key: settings[key] for key in ("name",) if key in settings}
    return settings


def provider_schedule_payload(frame: Frame) -> dict[str, Any]:
    """`set_schedule`'s payload: the enabled events only (devices fire every
    event they are given), capped to what the smallest device holds."""
    schedule = frame.schedule if isinstance(frame.schedule, dict) else {}
    events_out: list[dict[str, Any]] = []
    if not schedule.get("disabled"):
        for event in schedule.get("events") or []:
            if not isinstance(event, dict) or event.get("disabled") is True:
                continue
            name = event.get("event")
            minute = _integer(event.get("minute"))
            hour = _integer(event.get("hour"))
            weekday = _integer(event.get("weekday")) or 0
            if not isinstance(name, str) or not name or minute is None or hour is None:
                continue
            if not (0 <= minute <= 59 and 0 <= hour <= 23 and 0 <= weekday <= 9):
                continue
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if len(json.dumps(payload).encode("utf-8")) > MAX_SCHEDULE_EVENT_PAYLOAD_BYTES:
                continue
            events_out.append({
                "id": str(event.get("id") or f"{hour}:{minute}:{name}")[:64],
                "minute": minute,
                "hour": hour,
                "weekday": weekday,
                "event": name,
                "payload": payload,
            })
    return {"schedule": {"events": events_out[:MAX_SCHEDULE_EVENTS]}}


def scenes_checksum(scenes: list[Any]) -> str:
    """What the device echoes back in `scene_ack` and reports in its hello:
    the sha256 of the pushed scenes' canonical JSON."""
    body = json.dumps(scenes, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def provider_scenes(frame: Frame, scenes: Optional[list[Any]] = None) -> tuple[list[dict[str, Any]], int]:
    """The interpreted scenes a provider frame may be sent, for the runtime
    it reports (an older runtime gets a retired app's Nim keyword back), and
    how many compiled scenes were left out: the device refuses a compiled
    payload outright (`not_interpreted`)."""
    source = scenes if scenes is not None else (frame.scenes if isinstance(frame.scenes, list) else [])
    interpreted = [scene for scene in source if isinstance(scene, dict) and scene_is_interpreted(scene)]
    skipped = sum(1 for scene in source if isinstance(scene, dict)) - len(interpreted)
    return scenes_for_embedded_runtime(interpreted, provider_reported_version(frame)), skipped


def provider_scenes_payload(
    frame: Frame,
    scenes: Optional[list[Any]] = None,
    *,
    scene_id: Optional[str] = None,
    state: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, Any], int]:
    """`set_scenes`'s payload and the number of compiled scenes left out."""
    pushed, skipped = provider_scenes(frame, scenes)
    payload: dict[str, Any] = {"scenes": pushed, "checksum": scenes_checksum(pushed)}
    if scene_id:
        payload["scene_id"] = scene_id
    if isinstance(state, dict) and state:
        payload["state"] = state
    return payload, skipped
