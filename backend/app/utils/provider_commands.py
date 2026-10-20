"""Everything the backend does to a provider frame, as contract verbs.

A provider frame (app/utils/provider_frames.py) dials the backend's
management socket, which relays to the provider sidecar: FrameOS Cloud's
frame hub, unmodified, on its own Postgres (cloud/apps/backend-provider;
app/ws/provider_relay.py). The command queue is the hub's (`frame_commands`
in the sidecar's database, drained with the cloud's rules); this module
queues verbs through the sidecar's bridge (app/utils/provider_bridge.py),
waits for their acks, and reads back what a data-returning verb sent (an
asset listing, a state, a file), which the hub keeps where the cloud keeps
it.

What the frame reports on its own (logs, metrics, state, deploy progress)
reaches the backend's tables through the mirror (app/tasks/provider_mirror.py),
which follows the hub's fleet socket.
"""
from __future__ import annotations

import asyncio
import base64
import json
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log
from app.utils import provider_bridge
from app.utils.frame_commands import SUPERSEDED_TYPES, base_ttl_seconds
from app.utils.provider_bridge import BridgeError
from app.utils.provider_frames import provider_link, provider_profile
from app.utils.provider_payloads import (
    provider_scenes_payload,
    provider_schedule_payload,
    provider_settings_payload,
)

POLL_SECONDS = 0.25
# The largest single message the hub sends (the cloud's maxPayloadBytes);
# the ESP32 refuses anything over its own 512 KiB.
MAX_MESSAGE_BYTES = {"linux": 4 * 1024 * 1024, "esp32": 512 * 1024}
# One asset_put carries the whole file up to the device's single-message cap
# (the contract's assetPutMaxBytes); bigger files ride asset_put_chunk.
CHUNK_BYTES = {"linux": 1024 * 1024, "esp32": 192 * 1024}
# The hub keeps an image_get reply here (auth-web frames.ts frameImageAssetPath).
FRAME_IMAGE_ASSET_PATH = ".frame/image"
# Deploys waiting for the frame's acks, so the one that settles while the job
# is long gone still becomes the frame's deploy baseline (the mirror records
# it, app/tasks/provider_mirror.py).
DEPLOY_KEY_TTL_SECONDS = 30 * 24 * 60 * 60

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


class ProviderCommandError(Exception):
    """The device refused the verb (its ack's `error`), never answered, or
    the sidecar is not there."""

    def __init__(self, error: str):
        super().__init__(error)
        self.error = error


# ------------------------------------------------------------- transport

def _link_body(frame: Frame) -> dict[str, Any]:
    link = provider_link(frame)
    assert link is not None
    return {
        "name": frame.name,
        "project_id": int(frame.project_id),
        "public_key": link.public_key,
        "token_hash": link.token_hash,
        "scopes": link.scope_list(),
        "hardware": link.hardware,
        "frameos_version": link.frameos_version,
        "local_origin": link.local_origin,
    }


async def provider_link_changed(redis: Redis, frame_id: int) -> None:
    """The frame enrolled or was re-keyed: its link token's hash and device
    key become the sidecar's linked client and frame row, so the hub
    authenticates its socket — and closes one open under an old key (4401).
    Best effort: a sidecar that is down gets the frame on its first verb."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        frame = db.get(Frame, int(frame_id))
        link = provider_link(frame) if frame is not None else None
        if frame is None or link is None:
            return
        try:
            link.remote_frame_id = await provider_bridge.register_frame(int(frame.id), _link_body(frame))
            db.commit()
        except BridgeError:
            db.rollback()
    finally:
        db.close()


async def forget_provider_frame(remote_frame_id: Optional[str]) -> None:
    """The backend deleted the frame: the hub revokes it (4401) and the
    sidecar's rows go."""
    if not remote_frame_id:
        return
    try:
        await provider_bridge.delete_frame(remote_frame_id)
    except BridgeError:
        pass


async def _remote_id(frame: Frame) -> str:
    link = provider_link(frame)
    if link is None:
        raise ProviderCommandError("not_a_provider_frame")
    if not link.remote_frame_id:
        try:
            link.remote_frame_id = await provider_bridge.register_frame(int(frame.id), _link_body(frame))
        except BridgeError as exc:
            raise ProviderCommandError(exc.error)
        from sqlalchemy.orm import object_session

        session = object_session(link)
        if session is not None:
            session.commit()
    return str(link.remote_frame_id)


def _connected(frame: Frame) -> bool:
    link = provider_link(frame)
    return bool(link is not None and link.connected)


def _public(command: dict[str, Any], detail: Optional[str]) -> dict[str, Any]:
    out = {key: command.get(key) for key in ("id", "type", "status", "created_at", "expires_at", "sent_at")}
    if detail:
        out["detail"] = detail
    return out


def _outcome(command: Optional[dict[str, Any]], detail: Optional[str] = None) -> dict[str, Any]:
    """What a producer route answers (embedded_commands.command_outcome's
    shape): applied, failed with the device's error, or still queued."""
    if command is None:
        return {"status": "queued", "applied": False, "command": None}
    status = command.get("status")
    applied = status == "acked"
    failed = status == "failed"
    return {
        "status": "applied" if applied else "failed" if failed else "queued",
        "applied": applied,
        "error": command.get("error") if failed else None,
        "command": _public(command, detail),
    }


async def _enqueue(frame: Frame, command_type: str, payload: Optional[dict[str, Any]] = None, *, ttl_seconds: Optional[int] = None) -> dict[str, Any]:
    remote_id = await _remote_id(frame)
    base_ttl = base_ttl_seconds(command_type)
    if ttl_seconds is not None and base_ttl is not None:
        base_ttl = int(ttl_seconds)
    try:
        return await provider_bridge.enqueue_command(
            remote_id, command_type, payload, ttl_seconds=base_ttl, supersede=command_type in SUPERSEDED_TYPES
        )
    except BridgeError as exc:
        raise ProviderCommandError(exc.error)


async def _wait(frame: Frame, command: dict[str, Any], timeout: float) -> dict[str, Any]:
    """The command once the device answered it, or as it stands at the end."""
    remote_id = await _remote_id(frame)
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max(0.0, timeout)
    while command.get("status") in ("pending", "sent") and loop.time() < deadline:
        await asyncio.sleep(POLL_SECONDS)
        try:
            command = await provider_bridge.command_status(remote_id, str(command["id"]))
        except BridgeError:
            break
    return command


async def _await_acked(frame: Frame, command: dict[str, Any], timeout: float) -> dict[str, Any]:
    command = await _wait(frame, command, timeout)
    status = command.get("status")
    if status in ("failed", "expired"):
        raise ProviderCommandError(command.get("error") or str(status))
    if status != "acked":
        raise ProviderCommandError("frame_not_responding" if not _connected(frame) else "timeout")
    return command


def _require_connected(frame: Frame) -> None:
    """A request the owner waits on (an asset listing, a download) cannot
    queue for a frame that is away: say so instead of hanging."""
    if not _connected(frame):
        raise ProviderCommandError("frame_offline")


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
    """Queue one verb on the hub and wait up to `wait_seconds` for the ack
    when the frame is connected. Returns `applied`, `failed` with the
    device's error, or `queued` for a frame that is away."""
    check_message_size(frame, command_type, payload)
    command = await _enqueue(frame, command_type, payload, ttl_seconds=ttl_seconds)
    if not quiet:
        label = COMMAND_LABELS.get(command_type, command_type.replace("_", " "))
        line = log_line or f"Queued for the frame: {label}{f' ({detail})' if detail else ''}"
        await new_log(db, redis, int(frame.id), "stdinfo", line)
    if wait_seconds > 0 and _connected(frame):
        command = await _wait(frame, command, wait_seconds)
    return _outcome(command, detail)


# --------------------------------------------------------------- deploys

def _deploys_key(frame_id: int) -> str:
    return f"frameos:provider_deploys:{int(frame_id)}"


def _deploy_result_key(deploy_id: str) -> str:
    return f"frameos:provider_deploy_result:{deploy_id}"


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
    snapshot that becomes the frame's deploy baseline once the device acks
    the scenes and the settings waits in redis with the verbs' ids (the hub's
    queue carries no bookkeeping of ours). Returns the deploy id."""
    deploy_id = uuid4().hex
    settings = provider_settings_payload(frame)
    scenes_payload, skipped = provider_scenes_payload(frame, scene_id=scene_id, state=state)
    check_message_size(frame, "set_scenes", scenes_payload)
    scene_count = len(scenes_payload["scenes"])
    awaited: list[str] = []
    if settings:
        awaited.append(str((await _enqueue(frame, "set_settings", {"settings": settings}))["id"]))
    await _enqueue(frame, "set_schedule", provider_schedule_payload(frame))
    awaited.append(str((await _enqueue(frame, "set_scenes", scenes_payload))["id"]))
    # The keys the new scenes may read: the device pulls them on the nudge.
    await _enqueue(frame, "refresh_service_settings")
    deploys = await _pending_deploys(redis, int(frame.id))
    deploys = [entry for entry in deploys if entry.get("id") != deploy_id][-4:]
    deploys.append({"id": deploy_id, "commands": awaited, "snapshot": snapshot})
    await redis.set(_deploys_key(int(frame.id)), json.dumps(deploys), ex=DEPLOY_KEY_TTL_SECONDS)
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
    return deploy_id


async def _pending_deploys(redis: Redis, frame_id: int) -> list[dict[str, Any]]:
    raw = await redis.get(_deploys_key(frame_id))
    try:
        value = json.loads(raw) if raw else []
    except ValueError:
        value = []
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


async def provider_deploy_state(db: Session, frame: Frame, deploy_id: str, redis: Optional[Redis] = None) -> str:
    """Where this deploy stands: `pending` while the frame has a verb of it
    still to answer, then `acked` or `failed`."""
    from app.redis import get_shared_redis

    redis = redis or get_shared_redis()
    result = await redis.get(_deploy_result_key(deploy_id))
    if result:
        return result.decode() if isinstance(result, bytes) else str(result)
    entry = next((e for e in await _pending_deploys(redis, int(frame.id)) if e.get("id") == deploy_id), None)
    if entry is None:
        return "failed"
    statuses = await _command_statuses(frame, entry)
    if any(status in ("pending", "sent") for status in statuses):
        return "pending"
    return "acked" if all(status == "acked" for status in statuses) else "failed"


async def _command_statuses(frame: Frame, entry: dict[str, Any]) -> list[Any]:
    remote_id = await _remote_id(frame)
    statuses: list[Any] = []
    for command_id in entry.get("commands") or []:
        try:
            statuses.append((await provider_bridge.command_status(remote_id, str(command_id))).get("status"))
        except BridgeError:
            statuses.append("pending")
    return statuses


async def record_settled_provider_deploys(db: Session, redis: Redis, frame: Frame) -> bool:
    """Every deploy of this frame whose verbs the device has answered is
    settled: one it acked becomes the frame's deploy baseline (the newest
    last), one it refused or let expire is dropped. Called by the deploy job
    and by the mirror on every frame update; a per-frame lock makes sure a
    deploy is recorded once. Returns whether a baseline was recorded."""
    from app.models.frame import record_successful_deploy, update_frame

    lock_key = f"frameos:provider_deploys_lock:{int(frame.id)}"
    if not await redis.set(lock_key, "1", nx=True, ex=30):
        return False
    try:
        deploys = await _pending_deploys(redis, int(frame.id))
        if not deploys:
            return False
        remaining: list[dict[str, Any]] = []
        recorded = False
        for entry in deploys:
            statuses = await _command_statuses(frame, entry)
            if any(status in ("pending", "sent") for status in statuses):
                remaining.append(entry)
                continue
            acked = all(status == "acked" for status in statuses)
            await redis.set(_deploy_result_key(str(entry.get("id"))), "acked" if acked else "failed", ex=3600)
            if acked and isinstance(entry.get("snapshot"), dict):
                record_successful_deploy(frame, entry["snapshot"])
                recorded = True
        if recorded:
            if frame.status in ("deploying", "uninitialized"):
                frame.status = "ready"
            await update_frame(db, redis, frame)
            await new_log(db, redis, int(frame.id), "stdinfo", "✅ The frame took the deploy; recorded as deployed")
        if remaining:
            await redis.set(_deploys_key(int(frame.id)), json.dumps(remaining), ex=DEPLOY_KEY_TTL_SECONDS)
        else:
            await redis.delete(_deploys_key(int(frame.id)))
        return recorded
    finally:
        await redis.delete(lock_key)


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


# ---------------------------------------------------------------- queries

def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def provider_request_state(db: Session, redis: Redis, frame: Frame, timeout: float = 10.0) -> dict[str, Any]:
    """get_state: the device answers with a `state` message, which the hub
    keeps as the frame's last state; that is copied onto the link here."""
    _require_connected(frame)
    command = await _enqueue(frame, "get_state")
    await _await_acked(frame, command, timeout)
    await asyncio.sleep(POLL_SECONDS)
    try:
        summary = await provider_bridge.frame_summary(await _remote_id(frame))
    except BridgeError as exc:
        raise ProviderCommandError(exc.error)
    reported = summary.get("last_state")
    state: dict[str, Any] = reported if isinstance(reported, dict) else {}
    link = provider_link(frame)
    if link is not None:
        link.last_state = state
        db.commit()
    return {"states": state, "active_scene": state.get("active_scene")}


async def provider_list_assets(db: Session, redis: Redis, frame: Frame, timeout: float = 30.0) -> dict[str, Any]:
    """assets_list: the listing the device sends after its ack, as the hub
    stored it (frame_assets)."""
    _require_connected(frame)
    asked_at = datetime.now(timezone.utc)
    command = await _enqueue(frame, "assets_list")
    await _await_acked(frame, command, timeout)
    remote_id = await _remote_id(frame)
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            listing = await provider_bridge.asset_listing(remote_id)
        except BridgeError as exc:
            raise ProviderCommandError(exc.error)
        updated = _parse_iso(listing.get("updated_at")) if listing else None
        if listing is not None and updated is not None and updated >= asked_at.replace(microsecond=0):
            return {"assets": listing.get("assets") or [], "truncated": bool(listing.get("truncated"))}
        if loop.time() >= deadline:
            raise ProviderCommandError("timeout")
        await asyncio.sleep(POLL_SECONDS)


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
    """asset_get / image_get: the bare ack, then the asset_chunk stream the
    hub reassembles and keeps (frame_asset_files)."""
    if require_connected:
        _require_connected(frame)
    path = FRAME_IMAGE_ASSET_PATH if command_type == "image_get" else str((payload or {}).get("path") or "")
    thumb = bool((payload or {}).get("thumb"))
    asked_at = datetime.now(timezone.utc)
    command = await _enqueue(frame, command_type, payload)
    await _await_acked(frame, command, timeout)
    remote_id = await _remote_id(frame)
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            found = await provider_bridge.asset_file(remote_id, path, thumb=thumb)
        except BridgeError as exc:
            raise ProviderCommandError(exc.error)
        if found is not None:
            data, content_type, updated_at = found
            updated = _parse_iso(updated_at)
            if updated is not None and updated >= asked_at.replace(microsecond=0):
                return data, content_type or None
        if loop.time() >= deadline:
            raise ProviderCommandError("timeout")
        await asyncio.sleep(POLL_SECONDS)


async def provider_asset_write(
    db: Session,
    redis: Redis,
    frame: Frame,
    command_type: str,
    payload: dict[str, Any],
    *,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """A write verb, waited for: its ack or the device's refusal."""
    _require_connected(frame)
    command = await _enqueue(frame, command_type, payload)
    await _await_acked(frame, command, timeout)
    return {}


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
        try:
            await queue_provider_command(db, redis, link.frame, "refresh_service_settings", quiet=True)
            nudged += 1
        except ProviderCommandError:
            continue
    return nudged


async def provider_pending_commands(frame: Frame) -> list[dict[str, Any]]:
    """The "Waiting for the frame" panel: the hub's queue, oldest first."""
    try:
        return await provider_bridge.pending_commands(await _remote_id(frame))
    except (BridgeError, ProviderCommandError):
        return []


async def provider_cancel_command(frame: Frame, command_id: str) -> bool:
    try:
        return await provider_bridge.cancel_command(await _remote_id(frame), command_id)
    except BridgeError:
        return False
