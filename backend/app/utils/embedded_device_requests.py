"""Deploys that wait for an embedded (ESP32) frame to check in.

A battery frame deep-sleeps and is rarely awake when someone deploys. Most of
a deploy needs nothing pushed: the device pulls its scenes (/embedded/scenes)
and its live settings (/embedded/settings) at the start of every pass. Two
parts of a deploy used to need the device awake, and ride that settings pull
as one-shot requests instead (embedded/esp32/main/fos_device_request.h):

- ``console``: the `set` list USB "Apply frame settings" sends
  (embedded_provisioning_plan) — board preset, panel, pins, buttons, SD
  wiring, power, render mode… — minus what connects the frame to its control
  plane (Wi-Fi, backend URL, API key, frame id): one wrong value there would
  cut the frame off from the backend that could correct it. Its id is a hash
  of the list, so a deploy that changes none of it is not re-applied (each
  application restarts the frame).
- ``ota``: "install the latest release", what POST /api/action/ota does. A
  new id per request; cleared once the device reports it acted on it, so a
  board re-flashed later (NVS wiped) does not replay an old update.

Firmware before QUEUED_REQUESTS_FIRMWARE_VERSION ignores ``requests``.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from app.models.frame import Frame
from app.utils.embedded_scene_state import SCENE_REQUEST_FIRMWARE_VERSION, firmware_applies_scene_requests
from app.utils.versions import version_tuple

# The same firmware release reads scene, console and OTA requests.
QUEUED_REQUESTS_FIRMWARE_VERSION = SCENE_REQUEST_FIRMWARE_VERSION

# Mirrors k_console_keys in embedded/esp32/main/fos_device_request.c; the
# device refuses anything else whatever the backend sends.
CONSOLE_REQUEST_KEYS = frozenset({
    "hardware",
    "panel",
    "pins",
    "gpio_buttons",
    "hostname",
    "render_mode",
    "interval",
    "rotate",
    "scaling_mode",
    "time_zone",
    "server_send_logs",
    "max_http_response_bytes",
    "admin_user",
    "admin_pass",
    "admin_auth",
    "assets_sd",
    "assets_sd_pins",
    "assets_sd_freq",
    "deep_sleep",
    "deep_sleep_on_battery",
    "wake_check",
    "wake_schedule",
    "battery_pin",
    "battery_divider",
    "battery_enable_pin",
})


def firmware_applies_device_requests(frame: Frame) -> bool:
    return firmware_applies_scene_requests(frame)


def firmware_request_support(frame: Frame) -> str:
    """"yes" / "no" for a frame whose boot reported its firmware version,
    "unknown" for one that has not reported to this backend yet. A queued
    request is worth recording for "unknown": it is how a frame that has
    never been awake while someone looked gets its first deploy, and the
    answer says what it depends on. "no" is refused up front: that firmware
    would never read it."""
    embedded = getattr(frame, "embedded", None)
    embedded = embedded if isinstance(embedded, dict) else {}
    last_boot = embedded.get("lastBoot") if isinstance(embedded.get("lastBoot"), dict) else {}
    if version_tuple(last_boot.get("frameosVersion")) is None:
        return "unknown"
    return "yes" if firmware_applies_device_requests(frame) else "no"


def unknown_firmware_note(frame: Frame) -> str:
    """What a request queued for a frame of unknown firmware depends on."""
    if getattr(frame, "last_log_at", None):
        return (
            "The frame has not reported its firmware version to this backend yet (it does at its next boot); "
            f"it applies this if it runs FrameOS {QUEUED_REQUESTS_FIRMWARE_VERSION} or newer."
        )
    return (
        "The frame has not checked in with this backend yet; it picks this up at its first check-in "
        f"if it runs FrameOS {QUEUED_REQUESTS_FIRMWARE_VERSION} or newer."
    )


def _requests(frame: Frame) -> dict[str, Any]:
    stored = getattr(frame, "device_requests", None)
    stored = stored if isinstance(stored, dict) else {}
    return {key: value for key, value in stored.items() if isinstance(value, dict)}


def console_request_for_frame(frame: Frame) -> dict[str, Any] | None:
    """The deployable part of the frame's provisioning plan, or None when
    there is nothing in it to send."""
    from app.tasks.embedded_firmware import embedded_provisioning_plan

    plan = embedded_provisioning_plan(frame)
    settings = [
        [str(item["key"]), str(item["value"])]
        for item in plan.get("settings") or []
        if isinstance(item, dict) and item.get("key") in CONSOLE_REQUEST_KEYS
    ]
    if not settings:
        return None
    digest = hashlib.sha256(json.dumps(settings, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"id": digest[:32], "settings": settings}


def queue_console_request(frame: Frame) -> bool:
    """Record the console settings for the next pull. True when they differ
    from what was queued before (the device will apply them and restart).
    The caller commits."""
    request = console_request_for_frame(frame)
    requests = _requests(frame)
    previous = requests.get("console")
    if request is None:
        requests.pop("console", None)
    else:
        requests["console"] = request
    frame.device_requests = requests or None
    return request is not None and (previous or {}).get("id") != request["id"]


def queue_ota_request(frame: Frame) -> str:
    """Record a firmware update for the next pull; the caller commits."""
    request_id = uuid.uuid4().hex
    requests = _requests(frame)
    requests["ota"] = {"id": request_id}
    frame.device_requests = requests
    return request_id


def device_requests_payload(frame: Frame) -> dict[str, Any] | None:
    """The `requests` object of the /embedded/settings answer."""
    requests = _requests(frame)
    payload: dict[str, Any] = {}
    console = requests.get("console")
    if isinstance(console, dict) and isinstance(console.get("id"), str) and isinstance(console.get("settings"), list):
        payload["console"] = {"id": console["id"], "settings": console["settings"]}
    ota = requests.get("ota")
    if isinstance(ota, dict) and isinstance(ota.get("id"), str):
        payload["ota"] = {"id": ota["id"]}
    return payload or None


def requests_after_device_report(frame: Frame, log: dict[str, Any]) -> dict[str, Any] | None | bool:
    """What `device_requests` becomes once the device logged acting on one
    (its `deploy:request` line), or False when nothing changes. Only the OTA
    request is cleared: the console request stays, it is the frame's settings
    and costs nothing once applied (the device remembers its id)."""
    if log.get("event") != "deploy:request" or log.get("kind") != "ota":
        return False
    requests = _requests(frame)
    ota = requests.get("ota")
    if not isinstance(ota, dict) or ota.get("id") != log.get("id"):
        return False
    requests.pop("ota", None)
    return requests or None
