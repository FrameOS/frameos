"""Everything the backend does to a provider frame, as contract verbs.

A provider frame (app/utils/provider_frames.py) is reached only through its
command queue (app/utils/frame_commands.py), drained over its management
socket by app/ws/provider_hub.py. This module is what the rest of the
backend calls: queue a verb and wake the hub, wait for the ack, and wait for
what a data-returning verb sends back (an asset listing, a state, a file).

What the device sends back in reply to a verb lands in redis under the
command's id, written by the hub process and read by whichever process
queued the verb (a request on the Home Assistant ingress uvicorn, a job on
the arq worker): `provider_result:<id>` for a JSON reply, `provider_file:<id>`
for an `asset_chunk` stream, assembled.
"""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any, Optional
from uuid import uuid4

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.log import new_log
from app.utils.embedded_commands import command_outcome, wait_for_frame_command
from app.utils.frame_commands import deploy_commands_settled, enqueue_frame_command, get_frame_command
from app.utils.provider_frames import provider_link, provider_profile
from app.utils.provider_payloads import (
    provider_scenes_payload,
    provider_schedule_payload,
    provider_settings_payload,
)

# How long a reply waits in redis for whoever queued the verb.
RESULT_TTL_SECONDS = 10 * 60
RESULT_POLL_SECONDS = 0.2
# The largest single message the hub sends (and the cloud's maxPayloadBytes);
# the ESP32 refuses anything over its own 512 KiB.
MAX_MESSAGE_BYTES = {"linux": 4 * 1024 * 1024, "esp32": 512 * 1024}
# One asset_put carries the whole file up to the device's single-message cap
# (the contract's assetPutMaxBytes); bigger files ride asset_put_chunk.
CHUNK_BYTES = {"linux": 1024 * 1024, "esp32": 192 * 1024}

COMMAND_LABELS: dict[str, str] = {
    "set_scenes": "Deploy scenes",
    "set_settings": "Deploy settings",
    "set_schedule": "Deploy schedule",
    "set_current_scene": "Switch scene",
    "scene_event": "Scene event",
    "render": "Render now",
    "reboot": "Reboot",
    "restart_runtime": "Restart FrameOS",
    "notify_update_available": "Update FrameOS",
    "refresh_service_settings": "Refresh service settings",
    "set_display_power": "Display power",
}


# ------------------------------------------------------------- transport

# The hub's wake-up call: a command was queued, the link was re-keyed or
# revoked. Published on redis so a request served by another process (the
# Home Assistant ingress uvicorn, the arq worker) reaches the process holding
# the frame's socket — the cloud's NOTIFY on frameos_frame_commands.
PROVIDER_WAKE_CHANNEL = "frameos:provider:wake"


async def wake_provider_frame(redis: Redis, frame_id: int) -> None:
    from app.ws.provider_hub import wake_local

    wake_local(int(frame_id))
    await redis.publish(PROVIDER_WAKE_CHANNEL, str(int(frame_id)))


async def provider_link_changed(redis: Redis, frame_id: int) -> None:
    """The frame's link was re-keyed, revoked or deleted: the hub re-reads
    it and closes a socket open under the old one (4401)."""
    await wake_provider_frame(redis, frame_id)


def provider_deploy_settled(db: Session, frame: Frame, deploy_id: str) -> bool:
    """Has the frame acked every verb of this deploy?"""
    return deploy_commands_settled(db, frame, deploy_id)


class ProviderCommandError(Exception):
    """The device refused the verb (its ack's `error`), or never answered."""

    def __init__(self, error: str):
        super().__init__(error)
        self.error = error


def provider_result_key(command_id: str) -> str:
    return f"frameos:provider_result:{command_id}"


def provider_file_key(command_id: str) -> str:
    return f"frameos:provider_file:{command_id}"


async def store_provider_result(redis: Redis, command_id: str, result: dict[str, Any]) -> None:
    await redis.set(provider_result_key(command_id), json.dumps(result), ex=RESULT_TTL_SECONDS)


async def store_provider_file(redis: Redis, command_id: str, data: bytes, content_type: Optional[str]) -> None:
    record = {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}
    await redis.set(provider_file_key(command_id), json.dumps(record), ex=RESULT_TTL_SECONDS)


async def read_provider_result(redis: Redis, command_id: str) -> Optional[dict[str, Any]]:
    raw = await redis.get(provider_result_key(command_id))
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


async def read_provider_file(redis: Redis, command_id: str) -> Optional[tuple[bytes, Optional[str]]]:
    raw = await redis.get(provider_file_key(command_id))
    if not raw:
        return None
    try:
        record = json.loads(raw)
        return base64.b64decode(record["data"]), record.get("content_type")
    except (ValueError, KeyError, TypeError):
        return None


def _message_bytes(command_type: str, payload: Optional[dict[str, Any]]) -> int:
    wire = {key: value for key, value in (payload or {}).items() if not str(key).startswith("_")}
    return len(json.dumps({**wire, "id": "0" * 36, "type": command_type}, separators=(",", ":")).encode("utf-8"))


def check_message_size(frame: Frame, command_type: str, payload: Optional[dict[str, Any]]) -> None:
    """Refuse a verb no device of this profile would take in one message."""
    cap = MAX_MESSAGE_BYTES[provider_profile(frame)]
    size = _message_bytes(command_type, payload)
    if size > cap:
        raise ProviderCommandError(f"payload_too_large ({size} bytes, the frame takes {cap})")


async def queue_provider_command(
    db: Session,
    redis: Redis,
    frame: Frame,
    command_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    detail: Optional[str] = None,
    wait_seconds: float = 0.0,
    log_line: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Queue one verb, wake the hub, and wait up to `wait_seconds` for the
    ack when the frame is connected. Returns command_outcome() — `applied`,
    `failed` with the device's error, or `queued` for a frame that is away
    (the queue holds it for its next connection, as on the cloud)."""
    check_message_size(frame, command_type, payload)
    command = enqueue_frame_command(db, frame, command_type, payload, detail=detail, ttl_seconds=ttl_seconds)
    if not quiet:
        label = COMMAND_LABELS.get(command_type, command_type.replace("_", " "))
        line = log_line or f"Queued for the frame: {label}{f' ({detail})' if detail else ''}"
        await new_log(db, redis, int(frame.id), "stdinfo", line)
    await wake_provider_frame(redis, int(frame.id))
    link = provider_link(frame)
    if wait_seconds > 0 and link is not None and link.connected:
        command = await wait_for_frame_command(db, frame, command.id, wait_seconds) or command
    return command_outcome(command)


async def _await_command(db: Session, frame: Frame, command_id: str, timeout: float) -> FrameCommand:
    command = await wait_for_frame_command(db, frame, command_id, timeout)
    if command is None:
        raise ProviderCommandError("lost")
    if command.status == "failed":
        raise ProviderCommandError(command.error or "failed")
    if command.status == "expired":
        raise ProviderCommandError(command.error or "expired")
    if command.status != "acked":
        raise ProviderCommandError("frame_not_responding" if not _connected(frame) else "timeout")
    return command


def _connected(frame: Frame) -> bool:
    link = provider_link(frame)
    return bool(link is not None and link.connected)


async def _await_result(redis: Redis, db: Session, frame: Frame, command_id: str, timeout: float) -> dict[str, Any]:
    """The JSON reply a verb sends after its bare ack (`assets`, `state`)."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        result = await read_provider_result(redis, command_id)
        if result is not None:
            if isinstance(result.get("error"), str):
                raise ProviderCommandError(result["error"])
            return result
        db.expire_all()
        command = get_frame_command(db, frame, command_id)
        if command is not None and command.status in ("failed", "expired"):
            raise ProviderCommandError(command.error or command.status)
        if loop.time() >= deadline:
            raise ProviderCommandError("frame_not_responding" if not _connected(frame) else "timeout")
        await asyncio.sleep(RESULT_POLL_SECONDS)


async def _await_file(redis: Redis, db: Session, frame: Frame, command_id: str, timeout: float) -> tuple[bytes, Optional[str]]:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        found = await read_provider_file(redis, command_id)
        if found is not None:
            return found
        result = await read_provider_result(redis, command_id)
        if result is not None and isinstance(result.get("error"), str):
            raise ProviderCommandError(result["error"])
        db.expire_all()
        command = get_frame_command(db, frame, command_id)
        if command is not None and command.status in ("failed", "expired"):
            raise ProviderCommandError(command.error or command.status)
        if loop.time() >= deadline:
            raise ProviderCommandError("frame_not_responding" if not _connected(frame) else "timeout")
        await asyncio.sleep(RESULT_POLL_SECONDS)


def _require_connected(frame: Frame) -> None:
    """A request the owner waits on (an asset listing, a download) cannot
    queue for a frame that is away: say so instead of hanging."""
    if not _connected(frame):
        raise ProviderCommandError("frame_offline")


# --------------------------------------------------------------- deploys

async def queue_provider_deploy(
    db: Session,
    redis: Redis,
    frame: Frame,
    snapshot: Optional[dict[str, Any]] = None,
    *,
    scene_id: Optional[str] = None,
    state: Optional[dict[str, Any]] = None,
) -> str:
    """A deploy is three verbs: the settings, the schedule, the scenes. The
    scenes row carries the frame snapshot that becomes the deploy baseline
    once the device acks both the scenes and the settings (the hub records
    it, app/ws/provider_hub.py), and, when the deploy also switches scenes,
    the scene to show and its state. Returns the deploy id the rows share."""
    deploy_id = uuid4().hex
    settings = provider_settings_payload(frame)
    scenes_payload, skipped = provider_scenes_payload(frame, scene_id=scene_id, state=state)
    check_message_size(frame, "set_scenes", scenes_payload)
    scene_count = len(scenes_payload["scenes"])
    if settings:
        enqueue_frame_command(
            db, frame, "set_settings",
            {"settings": settings, "_deploy": {"id": deploy_id}},
            detail=f"{len(settings)} setting{'' if len(settings) == 1 else 's'}",
        )
    enqueue_frame_command(db, frame, "set_schedule", provider_schedule_payload(frame), detail="schedule")
    enqueue_frame_command(
        db, frame, "set_scenes",
        {**scenes_payload, "_deploy": {"id": deploy_id, "snapshot": snapshot}},
        detail=f"{scene_count} scene{'' if scene_count == 1 else 's'}",
    )
    # The keys the new scenes may read: the device pulls them on the nudge.
    enqueue_frame_command(db, frame, "refresh_service_settings")
    if skipped:
        await new_log(
            db, redis, int(frame.id), "stderr",
            f"⚠️ {skipped} compiled scene{' was' if skipped == 1 else 's were'} left out: a frame on its "
            "management socket runs interpreted scenes only. Convert them (docs/nim-to-js-conversion.md).",
        )
    await new_log(
        db, redis, int(frame.id), "stdinfo",
        f"Queued for the frame: {scene_count} scene{'' if scene_count == 1 else 's'}, the settings and the schedule",
    )
    await wake_provider_frame(redis, int(frame.id))
    return deploy_id


async def queue_provider_scene_preview(
    db: Session,
    redis: Redis,
    frame: Frame,
    scenes: list[Any],
    scene_id: Optional[str],
    state: Optional[dict[str, Any]] = None,
    *,
    wait_seconds: float = 0.0,
) -> dict[str, Any]:
    """"Preview on frame": the editor's scenes as one set_scenes naming the
    scene to show (docs/cloud-frames.md, the `scene_id` / `state` keys)."""
    payload, _skipped = provider_scenes_payload(frame, scenes, scene_id=scene_id, state=state)
    name = scene_id or f"{len(payload['scenes'])} scenes"
    return await queue_provider_command(
        db, redis, frame, "set_scenes", payload, detail=f"preview of {name}", wait_seconds=wait_seconds
    )


async def nudge_provider_service_settings(db: Session, redis: Redis, project_id: int) -> int:
    """The project's service keys changed: every provider frame that pulls
    them is told to pull again (`refresh_service_settings`, the zero-payload
    nudge; the keys themselves never ride the queue). Returns how many."""
    from app.models.frame_provider import FrameProviderLink
    from app.utils.provider_frames import SERVICE_SETTINGS_SCOPE

    links = db.query(FrameProviderLink).filter_by(project_id=int(project_id), status="active").all()
    nudged = 0
    for link in links:
        if SERVICE_SETTINGS_SCOPE not in link.scope_list() or link.frame is None:
            continue
        await queue_provider_command(db, redis, link.frame, "refresh_service_settings", quiet=True)
        nudged += 1
    return nudged


# ---------------------------------------------------------------- queries

async def provider_request_state(db: Session, redis: Redis, frame: Frame, timeout: float = 10.0) -> dict[str, Any]:
    _require_connected(frame)
    command = enqueue_frame_command(db, frame, "get_state")
    await wake_provider_frame(redis, int(frame.id))
    return await _await_result(redis, db, frame, command.id, timeout)


async def provider_list_assets(db: Session, redis: Redis, frame: Frame, timeout: float = 30.0) -> dict[str, Any]:
    _require_connected(frame)
    command = enqueue_frame_command(db, frame, "assets_list")
    await wake_provider_frame(redis, int(frame.id))
    return await _await_result(redis, db, frame, command.id, timeout)


async def provider_get_file(
    db: Session,
    redis: Redis,
    frame: Frame,
    command_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    timeout: float = 60.0,
    require_connected: bool = True,
) -> tuple[bytes, Optional[str]]:
    """`asset_get` / `image_get` / `scenes_get`: the bare ack, then the
    `asset_chunk` stream the hub assembles."""
    if require_connected:
        _require_connected(frame)
    command = enqueue_frame_command(db, frame, command_type, payload)
    await wake_provider_frame(redis, int(frame.id))
    return await _await_file(redis, db, frame, command.id, timeout)


async def provider_asset_write(
    db: Session,
    redis: Redis,
    frame: Frame,
    command_type: str,
    payload: dict[str, Any],
    *,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """A write verb, waited for: its ack (carrying `asset` for a put) or the
    device's refusal."""
    _require_connected(frame)
    command = enqueue_frame_command(db, frame, command_type, payload)
    await wake_provider_frame(redis, int(frame.id))
    await _await_command(db, frame, command.id, timeout)
    return await read_provider_result(redis, command.id) or {}


async def provider_upload_asset(
    db: Session, redis: Redis, frame: Frame, path: str, data: bytes, *, timeout: float = 120.0
) -> dict[str, Any]:
    """One file onto the device's assets directory: a single asset_put when
    it fits one message, offset-addressed asset_put_chunk parts when not."""
    profile = provider_profile(frame)
    from app.utils.cloud_frames_contract import contract_limit

    if len(data) <= contract_limit("assetPutMaxBytes", profile):
        return await provider_asset_write(
            db, redis, frame, "asset_put",
            {"path": path, "data": base64.b64encode(data).decode("ascii")}, timeout=timeout,
        )
    if len(data) > contract_limit("chunkedUploadMaxBytes", profile):
        raise ProviderCommandError("too_large")
    upload_id = uuid4().hex[: contract_limit("uploadIdMaxLen", profile)]
    chunk = CHUNK_BYTES[profile]
    offset = 0
    result: dict[str, Any] = {}
    while offset < len(data):
        part = data[offset: offset + chunk]
        last = offset + len(part) >= len(data)
        payload: dict[str, Any] = {
            "upload_id": upload_id,
            "offset": offset,
            "data": base64.b64encode(part).decode("ascii"),
        }
        if last:
            payload["complete"] = True
            payload["path"] = path
        result = await provider_asset_write(db, redis, frame, "asset_put_chunk", payload, timeout=timeout)
        offset += len(part)
    return result
