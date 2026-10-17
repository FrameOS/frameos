"""Queue a command for an embedded frame and, when it is awake, get it done now.

The queue (app/utils/frame_commands.py) is the truth; the device drains it on
every pull. What this module adds is the part the cloud's live socket gives
for free: a frame that is awake on the LAN takes a queued command within a
second, because the backend nudges it (`POST /api/action/commands` on the
device's own HTTP server, fos_http.c) to pull right away, and the caller can
wait a moment for the ack so the workspace says "applied" instead of
"queued" when it was. A frame that does not answer the nudge is asleep or
away: the command waits for its next pull, exactly as on the cloud.

Nothing is ever pushed to the device: every verb reaches it through the
pull, so the awake and the asleep case run the same device code.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

import httpx
from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.log import new_log
from app.utils.frame_commands import (
    enqueue_frame_command,
    frame_command_public,
    frame_is_asleep,
    get_frame_command,
)

# One quick attempt per candidate address, so a sleeping frame costs the
# caller a few seconds, not the full retrying frame timeout.
NUDGE_TIMEOUT = httpx.Timeout(connect=2.0, read=3.0, write=3.0, pool=2.0)
NUDGE_PATH = "/api/action/commands"
ACK_POLL_SECONDS = 0.2

# What the "Waiting for the frame" panel and the frame log call a verb.
COMMAND_LABELS: dict[str, str] = {
    "render": "Render now",
    "reboot": "Reboot",
    "restart_runtime": "Restart FrameOS",
    "set_current_scene": "Switch scene",
    "scene_event": "Scene event",
    "notify_update_available": "Check for a firmware update",
    "set_scenes": "Deploy scenes",
    "set_settings": "Deploy settings",
    "lan_access_challenge": "Show the local network access code",
    "lan_access_set": "Local network access",
}


def command_label(command: FrameCommand) -> str:
    label = COMMAND_LABELS.get(command.type, command.type.replace("_", " "))
    return f"{label} ({command.detail})" if command.detail else label


# The first firmware that pulls the queue (fos_commands.c). A frame that
# reported an older boot is still pushed to directly, as it always was: a
# queued command would sit on its row until the TTL — or, for a deploy with
# none, forever — because nothing on the device asks for it.
COMMAND_QUEUE_FIRMWARE_VERSION = "2026.10.5"


def embedded_reported_frameos_version(frame: Frame) -> str | None:
    """The FrameOS the device said it runs on its last boot (models/log.py
    records the bootup line under embedded.lastBoot), or None."""
    from app.models.log import _frameos_version_from_boot

    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    last_boot = embedded.get("lastBoot")
    if not isinstance(last_boot, dict):
        return None
    return _frameos_version_from_boot(last_boot.get("frameosVersion"))


def embedded_frame_pulls_commands(frame: Frame) -> bool:
    """Does this frame's firmware drain the command queue? Unknown (never
    booted against this backend) counts as yes: the release that carries
    this backend carries the firmware, and the fresh flash is that release."""
    from app.utils.versions import version_tuple

    reported = version_tuple(embedded_reported_frameos_version(frame))
    floor = version_tuple(COMMAND_QUEUE_FIRMWARE_VERSION)
    return reported is None or floor is None or reported >= floor


def is_embedded_device_frame(frame: Frame) -> bool:
    """An ESP32-class frame with a device behind it: embedded, and not a
    virtual frame (which renders in the backend and queues nothing)."""
    if (getattr(frame, "mode", None) or "rpios") != "embedded":
        return False
    from app.tasks.embedded_firmware import embedded_platform_spec_for_frame

    try:
        return embedded_platform_spec_for_frame(frame)["family"] != "virtual"
    except Exception:  # noqa: BLE001 - an unknown platform is still a device
        return True


def is_queued_embedded_frame(frame: Frame) -> bool:
    """A frame the backend reaches through its command queue: an embedded
    device on firmware that pulls it."""
    return is_embedded_device_frame(frame) and embedded_frame_pulls_commands(frame)


async def nudge_embedded_frame(frame: Frame, redis: Redis) -> bool:
    """Ask an awake frame to pull its commands now. False when it did not
    answer — asleep, off, or away — which is not an error: the queue waits.
    A frame whose own forecast says it is asleep is not even asked."""
    if frame_is_asleep(frame):
        return False
    from app.utils.frame_http import _fetch_frame_http_bytes

    try:
        status, _body, _headers = await _fetch_frame_http_bytes(
            frame,
            redis,
            path=NUDGE_PATH,
            method="POST",
            timeout=NUDGE_TIMEOUT,
            attempts=1,
        )
    except Exception:  # noqa: BLE001 - unreachable is the expected failure
        return False
    return 200 <= status < 300


async def wait_for_frame_command(
    db: Session, frame: Frame, command_id: str, timeout_seconds: float
) -> Optional[FrameCommand]:
    """The command once the device has answered it, or as it stands when the
    wait runs out. The ack lands through the device route in another
    request, so the session's copy is refreshed on every look."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max(0.0, timeout_seconds)
    while True:
        db.expire_all()
        command = get_frame_command(db, frame, command_id)
        if command is None or command.status not in ("pending", "sent"):
            return command
        if loop.time() >= deadline:
            return command
        await asyncio.sleep(ACK_POLL_SECONDS)


def command_outcome(command: FrameCommand | None) -> dict[str, Any]:
    """The answer a producer route gives: whether the frame has already acted
    on the command (`applied`), refused it (`failed`, with the device's
    error), or still has it waiting (`queued`)."""
    if command is None:
        return {"status": "queued", "applied": False, "command": None}
    status = command.status
    applied = status == "acked"
    failed = status == "failed"
    return {
        "status": "applied" if applied else "failed" if failed else "queued",
        "applied": applied,
        "error": command.error if failed else None,
        "command": frame_command_public(command),
    }


async def queue_embedded_command(
    db: Session,
    redis: Redis,
    frame: Frame,
    command_type: str,
    payload: dict[str, Any] | None = None,
    *,
    detail: str | None = None,
    wait_seconds: float = 0.0,
    log_line: str | None = None,
) -> dict[str, Any]:
    """Queue one command, nudge the frame, and wait up to `wait_seconds` for
    its ack when the nudge landed. Returns command_outcome()."""
    command = enqueue_frame_command(db, frame, command_type, payload, detail=detail)
    line = log_line or f"Queued for the frame: {command_label(command)}"
    await new_log(db, redis, int(frame.id), "stdinfo", line)
    nudged = await nudge_embedded_frame(frame, redis)
    if nudged and wait_seconds > 0:
        command = await wait_for_frame_command(db, frame, command.id, wait_seconds) or command
    return command_outcome(command)


async def queue_embedded_scene_preview(
    db: Session,
    redis: Redis,
    frame: Frame,
    scenes: list[Any],
    scene_id: str | None,
    *,
    wait_seconds: float = 0.0,
) -> dict[str, Any]:
    """"Preview on frame": what the device's own /uploadScenes does with
    {scenes, sceneId}, in two queued halves. The scenes become a set_scenes
    row the frame pulls like a deploy (`/embedded/scenes` serves them,
    frame_commands.previewed_scenes), and a set_current_scene after it
    switches to the previewed scene. A sleeping frame shows the preview on
    its next wake. The outcome is the scenes row's, acked once the frame
    reports holding them; set_scenes rows never fail, so neither does this."""
    shown = next((s for s in scenes if isinstance(s, dict) and s.get("id") == scene_id), None) if scene_id else None
    if shown is not None:
        name = shown.get("name") if isinstance(shown.get("name"), str) and shown.get("name") else scene_id
    else:
        name = f"{len(scenes)} scene{'' if len(scenes) == 1 else 's'}"
    command = enqueue_frame_command(
        db, frame, "set_scenes", {"_preview": {"scenes": scenes, "scene_id": scene_id}}, detail=f"preview of {name}"
    )
    if scene_id:
        enqueue_frame_command(db, frame, "set_current_scene", {"scene_id": scene_id}, detail=name)
    await new_log(db, redis, int(frame.id), "stdinfo", f"Queued for the frame: {command_label(command)}")
    nudged = await nudge_embedded_frame(frame, redis)
    if nudged and wait_seconds > 0:
        command = await wait_for_frame_command(db, frame, command.id, wait_seconds) or command
    return command_outcome(command)
