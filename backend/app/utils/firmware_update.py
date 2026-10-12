"""The frame row's `firmware_update`: what the device last said about a
firmware update, in ONE vocabulary for both device families.

Cloud parity. The hub folds the same lines into `frames.firmware_update`
(cloud/apps/frame-hub/src/protocol.ts `firmwareUpdateFromLogEntries`), and
the shared workspace reads the row through one decorator
(frontend/src/decorators/frame.tsx `frameFirmwareUpdateProgress`): the
frames list's status word, the change-status tile, the deploy drawer and
the "..." menu all say "updating firmware 42%" from it. Before this the
backend kept the lines only in the Logs panel, so a frame mid-download read
"ready" and the OTA button invited a second click.

The vocabulary (`status`):
  waiting       the ESP32 is letting a render pass that was already under way
                finish before it downloads (`detail` = "render")
  downloading   the device accepted the update and is fetching it
                (`version` = the release it is fetching, when it said)
  progress      "<written>/<total>" bytes so far (the ESP32 reports every
                512 KB; the Pi's archive download has no progress lines)
  verified      installed and verified; the device restarts into it
  error         the attempt failed; `detail` is the device's reason
  done          the boot that ended the update: `version` is what the frame
                now runs (firmware_update_after_boot); the frames list
                ignores it, the deploy drawer says "updated to X"
  up-to-date, skipped, downgrade-refused   nothing to do

Two producers:
  - embedded/esp32/main/fos_ota.c logs `ota:<plane>` lines (`plane` is
    "backend" or "cloud", whichever manifest it pulled); the version rides
    the "downloading" line's detail, later lines carry bytes or a reason.
  - frameos/src/frameos/upgrade.nim `upgradeStatusLogLine` logs
    `cloud:upgrade` lines (the runtime's upgrade watcher, so every control
    plane that reads the frame log gets them) whose `status` is the
    upgrade-status.json word; "running" covers the whole download+install
    and maps onto `downloading`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

STATUS_MAX_LENGTH = 32
DETAIL_MAX_LENGTH = 160
VERSION_MAX_LENGTH = 64
PLANE_MAX_LENGTH = 32

# upgrade-status.json words -> the row's vocabulary. "idle" is the file's
# resting state and says nothing about an update, so it maps to nothing.
PI_UPGRADE_STATUS_TO_ROW: dict[str, str] = {
    "error": "error",
    "failed": "error",
    "reboot_required": "verified",
    "running": "downloading",
    "scheduled": "downloading",
    "skipped": "skipped",
    "stalled": "error",
    "starting": "downloading",
    "success": "verified",
    "up_to_date": "up-to-date",
}


def _firmware_update_line(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    event = payload.get("event")
    status = payload.get("status")
    if not isinstance(event, str) or not isinstance(status, str):
        return None
    if event.startswith("ota:"):
        status = status[:STATUS_MAX_LENGTH]
        detail = payload.get("detail")
        detail = detail[:DETAIL_MAX_LENGTH] if isinstance(detail, str) else ""
        return {
            "detail": detail,
            "plane": event[4:4 + PLANE_MAX_LENGTH],
            "status": status,
            "version": detail if status == "downloading" and detail else None,
        }
    if event == "cloud:upgrade":
        row_status = PI_UPGRADE_STATUS_TO_ROW.get(status)
        if not row_status:
            return None
        message = payload.get("message")
        if not isinstance(message, str):
            message = payload.get("detail")
        if not isinstance(message, str):
            message = ""
        latest_version = payload.get("latest_version")
        return {
            "detail": message[:DETAIL_MAX_LENGTH],
            "plane": "cloud",
            "status": row_status,
            "version": (
                latest_version[:VERSION_MAX_LENGTH]
                if isinstance(latest_version, str) and latest_version
                else None
            ),
        }
    return None


def _firmware_update_interrupted_by_boot(payload: Any, current: Any) -> dict[str, Any] | None:
    """A `bootup` line while the row still says the device is downloading:
    the device restarted before the update finished, on the release it
    already had. The ESP32 forwards nothing while its control-plane socket is
    down (fos_cloud.c: the log tap is a tick coalescer, not a store), so the
    `ota:<plane> error` of a download that died in a socket gap never
    arrives — E1004 on the cloud, 2026-10-12: the row sat on "progress
    1048576/3233648" and the frames list on "updating firmware 32%" through
    the frame's next wake, then quietly went back to "upgrade". A boot on a
    NEW version is the update's success (firmware_update_is_over, in the
    caller's bootup branch). The cloud hub's firmwareUpdateInterruptedByBoot
    is the sibling."""
    if not isinstance(payload, dict) or payload.get("event") != "bootup":
        return None
    booted = payload.get("version")
    if not isinstance(booted, str):
        return None
    if not isinstance(current, dict) or current.get("status") not in ("waiting", "downloading", "progress"):
        return None
    booted = booted[1:] if booted.startswith("v") else booted
    booted = booted[:VERSION_MAX_LENGTH]
    target = current.get("version")
    target = target if isinstance(target, str) and target else None
    if not booted or booted == target:
        return None
    plane = current.get("plane")
    return {
        "detail": f"interrupted: the frame restarted on {booted} before the update finished"[:DETAIL_MAX_LENGTH],
        "plane": plane if isinstance(plane, str) else "cloud",
        "status": "error",
        "version": target,
    }


def is_firmware_update_log(payload: Any) -> bool:
    """Whether this device log line narrates a firmware update."""
    return _firmware_update_line(payload) is not None


def firmware_update_from_log(payload: Any, previous: Any, now: datetime) -> dict[str, Any] | None:
    """The row's new `firmware_update` for one device log line, folded over
    what the row already says, or None when the line is not about a firmware
    update — the caller leaves the row alone. A line that names no version
    keeps the one the row knew (the ESP32 says it once, on "downloading").
    A `bootup` on the old version while the row says downloading folds as
    the failure the device could not report (_firmware_update_interrupted_by_boot)."""
    line = _firmware_update_line(payload)
    if line is None:
        line = _firmware_update_interrupted_by_boot(payload, previous)
    if line is None:
        return None
    version = line["version"]
    if not version and isinstance(previous, dict) and isinstance(previous.get("version"), str):
        version = previous["version"]
    at = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return {
        "at": at.isoformat(),
        "detail": line["detail"],
        "plane": line["plane"],
        "status": line["status"],
        "version": version,
    }


def firmware_update_is_over(firmware_update: Any, reported_version: Any, known_version: str | None) -> bool:
    """Whether a boot report closes the row's firmware update: the install
    was verified (the device rebooted into it), or the version it now reports
    is not the one the row knew (a success the backend missed, or an error
    that belongs to a release no longer running). A failure on the SAME
    version stays — it is the one thing worth a word after the reboot."""
    if not isinstance(firmware_update, dict):
        return False
    if firmware_update.get("status") == "verified":
        return True
    return (
        isinstance(reported_version, str)
        and len(reported_version) > 0
        and reported_version != (known_version or "")
    )


# The row's statuses that narrate an update (as opposed to "nothing to do").
FIRMWARE_UPDATE_NARRATED_STATUSES = ("waiting", "downloading", "progress", "verified", "error", "done")

# Sentinel for "leave the row alone" (None means clear it).
LEAVE = object()


def firmware_update_after_boot(
    firmware_update: Any, reported_version: Any, known_version: str | None, now: datetime
) -> Any:
    """The row after a `bootup` line: LEAVE keeps it, None clears it, a dict
    replaces it. An update that is over (firmware_update_is_over) used to
    clear the row, which left the deploy drawer with nothing to say the
    moment the frame came back. It now folds into `done` with the version
    the frame reports, so the workspace can say "updated to 2026.10.8 · 3
    minutes ago"; a row that never narrated an update (up-to-date, skipped,
    downgrade-refused) clears. The cloud hub's firmwareUpdateAfterBoot is
    the sibling."""
    if not firmware_update_is_over(firmware_update, reported_version, known_version):
        return LEAVE
    row = firmware_update if isinstance(firmware_update, dict) else {}
    if row.get("status") not in FIRMWARE_UPDATE_NARRATED_STATUSES:
        return None
    row_version = row.get("version")
    version: Any = (
        reported_version[:VERSION_MAX_LENGTH]
        if isinstance(reported_version, str) and reported_version
        else row_version if isinstance(row_version, str) else None
    )
    at = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    plane = row.get("plane")
    detail = row.get("detail")
    return {
        "at": at.isoformat(),
        "detail": detail if row.get("status") == "verified" and isinstance(detail, str) else "",
        "plane": plane if isinstance(plane, str) else "cloud",
        "status": "done",
        "version": version,
    }


def firmware_update_done(folded: dict[str, Any]) -> dict[str, Any]:
    """The `done` row for a verified line that lands after the frame already
    came back on that version (firmware_update_already_applied)."""
    return {**folded, "status": "done"}


def firmware_update_already_applied(firmware_update: Any, running_version: Any) -> bool:
    """A "verified" line that lands AFTER the frame came back on the release
    it names has nothing left to narrate: the Pi's upgrade watcher reports
    `success` from the new runtime, after the bootup that cleared the row.
    Folded as-is the row said "rebooting into" a version the frame already
    ran, until the next boot (the cloud hub's firmwareUpdateAlreadyApplied
    is the sibling)."""
    if not isinstance(firmware_update, dict) or firmware_update.get("status") != "verified":
        return False
    version = firmware_update.get("version")
    return isinstance(version, str) and len(version) > 0 and version == running_version
