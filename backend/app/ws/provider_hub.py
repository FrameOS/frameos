"""The management WebSocket for frames this backend is the provider of.

docs/cloud-frames.md is the wire contract; cloud/apps/frame-hub/src/hub.ts
is the reference implementation this ports (docs/convergence-todo.md item 7,
Stage 1: "the backend hosts the management WebSocket"). A frame enrolled
with a claim token against this backend (app/api/provider_frames.py) dials
`/api/frames/ws` here exactly as it would dial FrameOS Cloud:

1. HTTP upgrade with `Authorization: Bearer <link token>`. A bad token is a
   plain `401` before the socket opens; too many sockets `503`, too many
   upgrades from one address `429` — never a 401, which a device counts
   toward demoting itself.
2. `challenge` (32 random bytes); the device answers `auth` with an Ed25519
   signature over the raw nonce bytes, verified against the key it enrolled
   with. `hello` and `auth` may come in either order; a challenge left
   unanswered for 15 s closes with 4408, a bad signature with 4401.
3. `ready {pending_commands, scopes}`, then the frame's command queue
   (app/utils/frame_commands.py, the same table and rules the ESP32 pull
   path uses), oldest first. Every verb is acked by id; a verb written but
   never acked is delivered again (at-most-once for reboot, restart,
   update and scene events), and a newer one of the same type supersedes it.

What the frame sends back lands where the backend keeps it for every other
frame: log lines through models/log.py process_log (so deploy progress,
status, sleep and firmware-update narration fold exactly as for a frame
posting `/api/log`), metrics in the metrics table, state in the states
cache, files and query replies in redis for whoever asked
(app/utils/provider_commands.py).

All durable state is in the database; the in-memory maps below are only the
routing table for live sockets in this process. A command queued by another
process (the Home Assistant ingress uvicorn, the arq worker) reaches the
socket through a redis publish (PROVIDER_WAKE_CHANNEL), the cloud's NOTIFY.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, WebSocket
from fastapi.responses import JSONResponse
from redis.asyncio import from_url as create_redis
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.config import config
from app.database import SessionLocal
from app.models.frame import Frame, remember_device_reported_frameos_version, set_deploy_progress, update_frame
from app.models.frame_command import FrameCommand
from app.models.frame_provider import FrameProviderLink
from app.models.log import new_log, process_log
from app.models.metrics import new_metrics
from app.redis import get_shared_redis
from app.utils.deploy_progress import fold as fold_deploy_progress
from app.utils.deploy_progress import fold_command as fold_deploy_progress_command
from app.utils.firmware_update import LEAVE as FIRMWARE_UPDATE_LEAVE
from app.utils.firmware_update import firmware_update_after_boot
from app.utils.frame_commands import (
    ASSET_TYPES,
    QUERY_TYPES,
    ack_frame_command,
    deploy_commands_settled,
    deploy_id_of,
    deploy_snapshot_for,
    drain_frame_commands,
    enqueue_frame_command,
    expire_stale_commands,
    frame_command_wire,
    get_frame_command,
    pending_command_count,
    redeliver_sent_commands,
    supersede_pending_commands,
    utcnow,
)
from app.utils.provider_commands import (
    COMMAND_LABELS,
    PROVIDER_WAKE_CHANNEL,
    store_provider_file,
    store_provider_result,
)
from app.utils.provider_frames import (
    FRAME_MANAGED_SCOPE,
    TELEMETRY_LOGS_SCOPE,
    TELEMETRY_METRICS_SCOPE,
    apply_hardware_to_frame,
    hash_secret,
    parse_hardware,
    safe_local_origin,
)
from app.utils.rate_limit import hit_rate_limit
from app.utils.request_ip import client_ip_for_request
from app.websockets import publish_message

logger = logging.getLogger(__name__)
router = APIRouter()

DEVICE_PATH = "/api/frames/ws"

# Close codes (docs/cloud-frames.md, "Session start"). 4408 is deliberately
# not 4401: devices count 4401s toward demoting themselves, and a slow
# device must be able to miss the auth window without eating a strike.
CLOSE_AUTH_FAILED = 4401
CLOSE_AUTH_TIMEOUT = 4408
CLOSE_SUPERSEDED = 4409
CLOSE_RESCOPED = 4410
CLOSE_TOO_BIG = 1009
CLOSE_GOING_AWAY = 1001

AUTH_TIMEOUT_SECONDS = 15.0
SWEEP_SECONDS = 30.0
# Sockets this process holds; past it an upgrade answers 503, not a 401.
MAX_SESSIONS = 1000
UPGRADES_PER_MINUTE_PER_IP = 120
# One number for the biggest frame that may cross the link either way (the
# hub's maxPayloadBytes); a log_batch of 200 lines of 8 KiB fits under it.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_STATE_BYTES = 64 * 1024
MAX_METRICS_BYTES = 16 * 1024
MAX_LOG_BATCH = 200
MAX_LOG_LINE_BYTES = 8 * 1024
MAX_SCENE_ID_CHARS = 256
MAX_CHECKSUM_CHARS = 128
MAX_SLEEP_SECONDS = 7 * 86400 + 3600
# Asset streams: what one device may have in flight, in bytes and in count.
MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_ASSET_STREAMS = 4
ASSET_STREAM_IDLE_SECONDS = 60.0
# A frame on flaky Wi-Fi can bounce every few seconds; one log line a minute.
CONNECT_LOG_DEBOUNCE_SECONDS = 60.0
# Inbound message budgets per frame per minute (the hub's frame_msg limits).
MESSAGE_LIMITS: dict[str, int] = {
    "scene_ack": 30,
    "state": 60,
    "log_batch": 120,
    "metrics": 30,
    "assets": 20,
    "render": 60,
}
# The fields a hello may carry before the device has proved its key.
HELLO_FIELDS = ("frameos_version", "states", "active_scene", "scenes_checksum", "scene_count", "hardware", "local_origin")


@dataclass
class AssetStream:
    chunks: list[bytes] = field(default_factory=list)
    size: int = 0
    next_seq: int = 0
    content_type: Optional[str] = None
    touched: float = field(default_factory=time.monotonic)


@dataclass
class DeviceSession:
    ws: WebSocket
    frame_id: int
    project_id: int
    link_id: str
    public_key: str
    token_hash: str
    scopes: list[str]
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    ready: bool = False
    closed: bool = False
    drain_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    streams: dict[str, AssetStream] = field(default_factory=dict)
    budgets: dict[str, list[float]] = field(default_factory=dict)

    def over_budget(self, message_type: str) -> bool:
        limit = MESSAGE_LIMITS.get(message_type)
        if limit is None:
            return False
        now = time.monotonic()
        window = [at for at in self.budgets.get(message_type, []) if now - at < 60.0]
        if len(window) >= limit:
            self.budgets[message_type] = window
            return True
        window.append(now)
        self.budgets[message_type] = window
        return False


# frame id -> the live, authenticated session for it (one per frame).
sessions: dict[int, DeviceSession] = {}
# Sockets accepted and still in the challenge, counted against MAX_SESSIONS.
_pending_sockets = 0
_background_tasks: set[asyncio.Task] = set()
_background_loop: Optional[asyncio.AbstractEventLoop] = None
# Set once the wake listener is subscribed: a socket is only told `ready`
# after that, so a command queued the moment it connects is not missed.
_listener_ready: Optional[asyncio.Event] = None
_last_connect_log: dict[int, float] = {}


def _now() -> datetime:
    return utcnow()


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _str(value: Any, limit: int) -> Optional[str]:
    return value[:limit] if isinstance(value, str) and value else None


def _within_bytes(value: Any, limit: int) -> bool:
    try:
        return len(json.dumps(value, separators=(",", ":")).encode("utf-8")) <= limit
    except (TypeError, ValueError):
        return False


def _state_with_active_scene(states: dict[str, Any], active_scene: Any) -> dict[str, Any]:
    """Devices report the active scene next to `states`; the stored state
    keeps it inside (the hub's stateWithActiveScene)."""
    if not isinstance(active_scene, str) or not active_scene:
        return states
    if isinstance(states.get("active_scene"), str) and states.get("active_scene"):
        return states
    return {**states, "active_scene": active_scene[:MAX_SCENE_ID_CHARS]}


# ------------------------------------------------------------- background

async def _ensure_background_tasks() -> None:
    """The redis wake listener and the sweep, once per process (per event
    loop: the test client runs each app in its own)."""
    global _background_loop, _listener_ready
    loop = asyncio.get_running_loop()
    if _background_loop is not loop or _listener_ready is None:
        _background_loop = loop
        _background_tasks.clear()
        _listener_ready = asyncio.Event()
        for coroutine in (_wake_listener(_listener_ready), _sweeper()):
            task = loop.create_task(coroutine)
            _background_tasks.add(task)
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(_listener_ready.wait(), timeout=5.0)


def wake_local(frame_id: int) -> bool:
    """Wake the frame's socket if this process holds it (a command queued by
    a request on the same uvicorn); the redis publish covers the others."""
    session = sessions.get(int(frame_id))
    if session is None:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    if loop is not _background_loop:
        return False
    _spawn(_wake(session))
    return True


async def _wake_listener(ready: asyncio.Event) -> None:
    backoff = 1.0
    while True:
        client = create_redis(config.REDIS_URL, decode_responses=True)
        try:
            pubsub = client.pubsub()
            await pubsub.subscribe(PROVIDER_WAKE_CHANNEL)
            ready.set()
            backoff = 1.0
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    frame_id = int(message["data"])
                except (TypeError, ValueError):
                    continue
                session = sessions.get(frame_id)
                if session is not None:
                    _spawn(_wake(session))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reconnect forever
            logger.warning("provider hub: wake listener lost redis, retrying in %.0fs: %s", backoff, exc)
        finally:
            with contextlib.suppress(Exception):
                await client.aclose()  # type: ignore[attr-defined]
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


async def _sweeper() -> None:
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        for session in list(sessions.values()):
            try:
                await _sweep(session)
            except Exception as exc:  # noqa: BLE001 - one bad session must not stop the sweep
                logger.warning("provider hub: sweep of frame %s failed: %s", session.frame_id, exc)


def _spawn(coroutine) -> None:
    task = asyncio.get_running_loop().create_task(coroutine)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ------------------------------------------------------------------- send

async def _send(session: DeviceSession, message: dict[str, Any]) -> bool:
    if session.closed or session.ws.application_state != WebSocketState.CONNECTED:
        return False
    text = json.dumps(message, separators=(",", ":"))
    try:
        async with session.send_lock:
            await session.ws.send_text(text)
        return True
    except Exception:  # noqa: BLE001 - a dead socket is handled by the receive loop
        return False


async def _close(session: DeviceSession, code: int, reason: str) -> None:
    if session.closed:
        return
    session.closed = True
    with contextlib.suppress(Exception):
        await session.ws.close(code=code, reason=reason)


async def _hub_ack(session: DeviceSession, message_id: Any, error: str) -> None:
    """The hub's own refusal of a device message, in the ack shape."""
    reply: dict[str, Any] = {"error": error, "ok": False, "type": "ack"}
    if isinstance(message_id, str) and message_id:
        reply["id"] = message_id
    await _send(session, reply)


# ------------------------------------------------------------------ state

def _link_is_current(db, session: DeviceSession) -> tuple[Optional[FrameProviderLink], Optional[int]]:
    """The session's link as it stands now, and the close code it calls for:
    4401 when it is gone, revoked or re-keyed (a new device key or a new
    link token), 4410 when its scopes changed under the socket."""
    link = db.get(FrameProviderLink, session.link_id)
    if (
        link is None
        or link.status != "active"
        or link.revoked_at is not None
        or link.public_key != session.public_key
        or link.token_hash != session.token_hash
    ):
        return link, CLOSE_AUTH_FAILED
    if sorted(link.scope_list()) != sorted(session.scopes):
        return link, CLOSE_RESCOPED
    return link, None


async def _check_current(session: DeviceSession) -> bool:
    db = SessionLocal()
    try:
        _link, close_code = _link_is_current(db, session)
    finally:
        db.close()
    if close_code == CLOSE_AUTH_FAILED:
        await _close(session, CLOSE_AUTH_FAILED, "frame_revoked")
        return False
    if close_code == CLOSE_RESCOPED:
        await _close(session, CLOSE_RESCOPED, "scopes_changed")
        return False
    return True


async def _remember_state(redis, frame: Frame, states: Any, active_scene: Any) -> None:
    """What the device shows, into the states cache the workspace reads
    (frames.py `/states`) and the active-scene key."""
    from app.api.frames import _frame_states_cache_key, _write_frame_states_cache

    scene_id = active_scene if isinstance(active_scene, str) and active_scene else None
    if scene_id:
        await redis.set(f"frame:{frame.id}:active_scene", scene_id[:MAX_SCENE_ID_CHARS])
    if not isinstance(states, dict) or not _within_bytes(states, MAX_STATE_BYTES):
        return
    # The firmware reports the resident scene's state flat; the cache keeps
    # the Linux `/states` shape, state by scene id.
    by_scene = {k: v for k, v in states.items() if k != "active_scene"}
    if scene_id and not any(isinstance(value, dict) for value in by_scene.values()):
        by_scene = {scene_id: by_scene}
    record = {"sceneId": scene_id or "", "states": by_scene}
    await _write_frame_states_cache(redis, _frame_states_cache_key(frame.id), record, fetched_at=time.time())


# ------------------------------------------------------------- activation

async def _activate(session: DeviceSession, hello: dict[str, Any], redis) -> None:
    previous = sessions.get(session.frame_id)
    if previous is not None and previous is not session:
        await _close(previous, CLOSE_SUPERSEDED, "superseded")
    sessions[session.frame_id] = session

    now = _now()
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        link = frame.provider_link if frame is not None else None
        if frame is None or link is None:
            await _close(session, CLOSE_AUTH_FAILED, "frame_revoked")
            return
        known_version = link.frameos_version
        link.connected = True
        link.session_id = session.id
        link.last_seen_at = now
        version = _str(hello.get("frameos_version"), 64)
        if version:
            link.frameos_version = version
            remember_device_reported_frameos_version(frame, version)
            after = firmware_update_after_boot(frame.firmware_update, version, known_version, now)
            if after is not FIRMWARE_UPDATE_LEAVE:
                frame.firmware_update = after
        hardware = parse_hardware(hello.get("hardware"))
        if hardware is not None:
            link.hardware = hardware
            apply_hardware_to_frame(frame, hardware)
        states = hello.get("states")
        if isinstance(states, dict) and _within_bytes(states, MAX_STATE_BYTES):
            link.last_state = _state_with_active_scene(states, hello.get("active_scene"))
        checksum = hello.get("scenes_checksum")
        if isinstance(checksum, str) and len(checksum) <= MAX_CHECKSUM_CHARS:
            link.scenes_checksum = checksum
        origin = safe_local_origin(hello.get("local_origin"))
        if origin and not link.local_origin:
            link.local_origin = origin
        # Talking, so whatever it forecast before its last sleep is spent.
        frame.next_wake_at = None
        frame.next_render_at = None
        frame.sleep_reason = None
        moved = fold_deploy_progress(frame.deploy_progress, "bootup", now=_aware(now))
        if moved is not None:
            frame.deploy_progress = moved
        db.commit()

        await _remember_state(redis, frame, hello.get("states"), hello.get("active_scene"))
        _request_device_scenes(db, frame, hello)
        expire_stale_commands(db, frame, now)
        # Whatever the previous socket was written and never answered.
        redeliver_sent_commands(db, frame, now)
        pending = pending_command_count(db, frame, now)
        db.commit()

        session.ready = True
        await _send(session, {
            "id": str(uuid.uuid4()),
            "pending_commands": pending,
            "scopes": session.scopes,
            "type": "ready",
        })
        await update_frame(db, redis, frame)
        last = _last_connect_log.get(frame.id)
        if last is None or time.monotonic() - last > CONNECT_LOG_DEBOUNCE_SECONDS:
            _last_connect_log[frame.id] = time.monotonic()
            await new_log(
                db, redis, int(frame.id), "stdinfo",
                f"Frame connected to the management socket (FrameOS {link.frameos_version or 'unknown'})",
            )
    finally:
        db.close()
    await _drain(session, redis)


def _request_device_scenes(db, frame: Frame, hello: dict[str, Any]) -> None:
    """A frame that joined already running scenes of its own says so with
    `scene_count`; while the backend holds none for it, ask for them
    (`scenes_get`) — the reply becomes the frame's scene list, the way an
    adoption imports the scenes a card already runs."""
    supersede_pending_commands(db, frame, "scenes_get")
    count = hello.get("scene_count")
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        return
    if isinstance(frame.scenes, list) and frame.scenes:
        return
    enqueue_frame_command(db, frame, "scenes_get", detail="the scenes the frame already runs")


async def _disconnect(session: DeviceSession, redis, reason: str) -> None:
    for stream_id in list(session.streams):
        session.streams.pop(stream_id, None)
    if sessions.get(session.frame_id) is session:
        sessions.pop(session.frame_id, None)
    if not session.ready:
        return
    db = SessionLocal()
    try:
        link = db.get(FrameProviderLink, session.link_id)
        # Guarded by the session id: a superseded socket closing late must
        # not mark the frame offline under the socket that replaced it.
        if link is None or link.session_id != session.id:
            return
        link.connected = False
        link.session_id = None
        link.last_seen_at = _now()
        db.commit()
        frame = db.get(Frame, session.frame_id)
        if frame is not None:
            await update_frame(db, redis, frame)
            if reason == "asleep":
                return
            last = _last_connect_log.get(frame.id)
            if last is None or time.monotonic() - last > CONNECT_LOG_DEBOUNCE_SECONDS:
                _last_connect_log[frame.id] = time.monotonic()
                await new_log(db, redis, int(frame.id), "stdinfo", f"Frame left the management socket ({reason})")
    finally:
        db.close()


# ------------------------------------------------------------------ drain

async def _drain(session: DeviceSession, redis) -> None:
    """Write every pending verb to the socket, oldest first. Rows are marked
    `sent` before the write; one that never reaches the device is delivered
    again (redeliver_sent_commands)."""
    if not session.ready or session.closed:
        return
    async with session.drain_lock:
        db = SessionLocal()
        try:
            frame = db.get(Frame, session.frame_id)
            if frame is None:
                return
            handed = drain_frame_commands(db, frame, _now(), pull_backed=False)
            refused: list[FrameCommand] = []
            wires: list[tuple[FrameCommand, str]] = []
            for command in handed:
                text = json.dumps(frame_command_wire(command), separators=(",", ":"))
                if len(text.encode("utf-8")) > MAX_MESSAGE_BYTES:
                    command.status = "failed"
                    command.error = "payload_too_large"
                    refused.append(command)
                else:
                    wires.append((command, text))
            db.commit()
            for command, text in wires:
                if session.closed:
                    break
                try:
                    async with session.send_lock:
                        await session.ws.send_text(text)
                except Exception:  # noqa: BLE001 - redelivered on the next connection
                    break
                await _fold_command(db, redis, frame, command)
            for command in refused:
                await _fold_command(db, redis, frame, command)
        finally:
            db.close()


async def _fold_command(db, redis, frame: Frame, command: FrameCommand) -> None:
    """A queue row of this frame changed state: the deploy's bar moves on
    `command:<sent|acked|failed>:<type>` (docs/deploy-progress-contract.json)."""
    moved = fold_deploy_progress_command(
        frame.deploy_progress, command.type, command.status,
        now=_aware(_now()), error=command.error,
    )
    await set_deploy_progress(db, redis, frame, moved)


async def _wake(session: DeviceSession) -> None:
    """A command was queued, or the link changed: re-check the link, then
    drain (redelivering what has gone unanswered for 180 s)."""
    if not session.ready or session.closed:
        return
    if not await _check_current(session):
        return
    await _drain(session, get_shared_redis())


async def _sweep(session: DeviceSession) -> None:
    if not session.ready or session.closed:
        return
    if not await _check_current(session):
        return
    now = time.monotonic()
    for stream_id, stream in list(session.streams.items()):
        if now - stream.touched > ASSET_STREAM_IDLE_SECONDS:
            session.streams.pop(stream_id, None)
    db = SessionLocal()
    try:
        # The protocol-level ping (uvicorn's) keeps the socket honest: a
        # device that stops answering is closed and reaches _disconnect.
        # While it answers, it is seen.
        link = db.get(FrameProviderLink, session.link_id)
        if link is not None and link.session_id == session.id:
            link.last_seen_at = _now()
            db.commit()
    finally:
        db.close()
    await _drain(session, get_shared_redis())


# --------------------------------------------------------------- messages

async def _handle(session: DeviceSession, message: dict[str, Any], redis) -> None:
    message_type = message.get("type")
    if message_type == "ack":
        await _on_ack(session, message, redis)
        return
    if message_type == "sleep":
        await _on_sleep(session, message, redis)
        return
    if message_type == "asset_chunk":
        await _on_asset_chunk(session, message, redis)
        return
    if message_type in MESSAGE_LIMITS and session.over_budget(message_type):
        await _hub_ack(session, message.get("id"), "rate_limited")
        return
    if message_type == "scene_ack":
        await _on_scene_ack(session, message, redis)
    elif message_type == "state":
        await _on_state(session, message, redis)
    elif message_type == "log_batch":
        await _on_log_batch(session, message, redis)
    elif message_type == "metrics":
        await _on_metrics(session, message, redis)
    elif message_type == "render":
        await _on_render(session, message, redis)
    elif message_type == "assets":
        await _on_assets(session, message, redis)
    # Anything else is ignored: a newer device's message an older provider
    # does not know is not an error.


async def _on_ack(session: DeviceSession, message: dict[str, Any], redis) -> None:
    command_id = message.get("id")
    ok = message.get("ok")
    if not isinstance(command_id, str) or not isinstance(ok, bool):
        return
    error = _str(message.get("error"), 512)
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        if frame is None:
            return
        command = get_frame_command(db, frame, command_id)
        if command is None:
            return
        was_live = command.status in ("pending", "sent")
        ack_frame_command(db, frame, command_id, ok=ok, error=error)
        db.commit()
        if ok:
            # A write verb's ack carries what landed; a query's data rides the
            # ack on the Linux runtime (get_logs / get_metrics inline).
            reply: dict[str, Any] = {key: message[key] for key in ("asset", "received") if key in message}
            if reply:
                await store_provider_result(redis, command_id, reply)
            if command.type == "get_logs" and isinstance(message.get("logs"), list):
                await _ingest_logs(session, frame, message["logs"], db, redis)
            if command.type == "get_metrics" and isinstance(message.get("metrics"), (dict, list)):
                await _ingest_metrics(session, frame, message["metrics"], db, redis)
        else:
            await store_provider_result(redis, command_id, {"error": error or "failed"})
        if not was_live:
            return
        await _fold_command(db, redis, frame, command)
        quiet = command.type in QUERY_TYPES or command.type in ASSET_TYPES or command.type == "scenes_get"
        label = COMMAND_LABELS.get(command.type, command.type.replace("_", " "))
        if command.detail:
            label = f"{label} ({command.detail})"
        if command.status == "failed":
            await new_log(db, redis, int(frame.id), "stderr", f"Frame refused: {label} ({command.error})")
        elif not quiet:
            await new_log(db, redis, int(frame.id), "stdinfo", f"Frame applied: {label}")
        if command.type == "set_current_scene" and command.status == "acked":
            scene_id = frame_command_wire(command).get("scene_id")
            if isinstance(scene_id, str) and scene_id:
                await redis.set(f"frame:{frame.id}:active_scene", scene_id)
        if command.type in ("set_scenes", "set_settings") and command.status == "acked":
            await _record_deploy_if_settled(db, redis, frame, command)
    finally:
        db.close()


async def _record_deploy_if_settled(db, redis, frame: Frame, command: FrameCommand) -> None:
    """Every row of a deploy acked: the snapshot it carried becomes the
    frame's deploy baseline, on the device's own word."""
    from app.models.frame import record_successful_deploy

    deploy_id = deploy_id_of(command)
    if not deploy_id or not deploy_commands_settled(db, frame, deploy_id):
        return
    snapshot = deploy_snapshot_for(db, frame, deploy_id)
    if snapshot is None:
        return
    record_successful_deploy(frame, snapshot)
    if frame.status in ("deploying", "uninitialized"):
        frame.status = "ready"
    await update_frame(db, redis, frame)
    await new_log(db, redis, int(frame.id), "stdinfo", "✅ The frame took the deploy; recorded as deployed")


async def _on_scene_ack(session: DeviceSession, message: dict[str, Any], redis) -> None:
    checksum = message.get("checksum")
    active_scene = _str(message.get("active_scene"), MAX_SCENE_ID_CHARS)
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        link = frame.provider_link if frame is not None else None
        if frame is None or link is None:
            return
        link.last_seen_at = _now()
        if isinstance(checksum, str) and len(checksum) <= MAX_CHECKSUM_CHARS:
            link.scenes_checksum = checksum
        if active_scene:
            state = dict(link.last_state) if isinstance(link.last_state, dict) else {}
            state["active_scene"] = active_scene
            link.last_state = state
        # The deploy's bar moves only on the ack of the push it is for: the
        # newest set_scenes this frame was sent.
        newest = (
            db.query(FrameCommand)
            .filter(FrameCommand.frame_id == frame.id, FrameCommand.type == "set_scenes")
            .filter(FrameCommand.status.in_(("sent", "acked")))
            .order_by(FrameCommand.created_at.desc(), FrameCommand.id.desc())
            .first()
        )
        newest_checksum = (newest.payload or {}).get("checksum") if newest is not None else None
        if isinstance(checksum, str) and checksum and checksum == newest_checksum:
            moved = fold_deploy_progress(frame.deploy_progress, "scene_ack", now=_aware(_now()))
            if moved is not None:
                frame.deploy_progress = moved
        db.commit()
        if active_scene:
            await redis.set(f"frame:{frame.id}:active_scene", active_scene)
        await update_frame(db, redis, frame)
    finally:
        db.close()


async def _on_state(session: DeviceSession, message: dict[str, Any], redis) -> None:
    states = message.get("states")
    if not isinstance(states, dict):
        states = {key: value for key, value in message.items() if key not in ("id", "type")}
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        link = frame.provider_link if frame is not None else None
        if frame is None or link is None:
            return
        link.last_seen_at = _now()
        if _within_bytes(states, MAX_STATE_BYTES):
            link.last_state = _state_with_active_scene(states, message.get("active_scene"))
        version = _str(message.get("frameos_version"), 64)
        if version:
            link.frameos_version = version
        checksum = message.get("scenes_checksum")
        if isinstance(checksum, str) and len(checksum) <= MAX_CHECKSUM_CHARS:
            link.scenes_checksum = checksum
        hardware = parse_hardware(message.get("hardware"))
        if hardware is not None:
            link.hardware = hardware
            apply_hardware_to_frame(frame, hardware)
        db.commit()
        await _remember_state(redis, frame, states, message.get("active_scene"))
        if isinstance(message.get("id"), str):
            # The reply to a get_state.
            await store_provider_result(redis, message["id"], {
                "states": states,
                "active_scene": message.get("active_scene"),
                "scenes_checksum": message.get("scenes_checksum"),
            })
        await update_frame(db, redis, frame)
    finally:
        db.close()


def _log_timestamp(value: Any) -> float:
    """Epoch seconds, epoch milliseconds or ISO, as epoch seconds; now when
    the device sent nothing usable (the hub's parseLogTimestamp)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return value / 1000.0 if value >= 1e12 else float(value)
    if isinstance(value, str):
        with contextlib.suppress(ValueError):
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return time.time()


async def _ingest_logs(session: DeviceSession, frame: Frame, entries: list[Any], db, redis) -> None:
    if TELEMETRY_LOGS_SCOPE not in session.scopes:
        return
    for entry in entries[:MAX_LOG_BATCH]:
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        scene = entry.get("scene")
        if isinstance(scene, str) and scene:
            payload = {"scene": scene[:MAX_SCENE_ID_CHARS], **payload} if isinstance(payload, dict) else {
                "payload": payload, "scene": scene[:MAX_SCENE_ID_CHARS]
            }
        if not isinstance(payload, dict):
            payload = {"event": "log", "message": payload if isinstance(payload, str) else json.dumps(payload)}
        if not _within_bytes(payload, MAX_LOG_LINE_BYTES):
            continue
        try:
            await process_log(db, redis, frame, [_log_timestamp(entry.get("timestamp")), payload])
        except Exception as exc:  # noqa: BLE001 - one bad line must not drop the batch
            logger.warning("provider hub: log line from frame %s refused: %s", frame.id, exc)
            db.rollback()


async def _on_log_batch(session: DeviceSession, message: dict[str, Any], redis) -> None:
    logs = message.get("logs")
    if not isinstance(logs, list):
        return
    if TELEMETRY_LOGS_SCOPE not in session.scopes:
        await _hub_ack(session, message.get("id"), "insufficient_scope")
        return
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        if frame is None:
            return
        await _ingest_logs(session, frame, logs, db, redis)
    finally:
        db.close()


async def _ingest_metrics(session: DeviceSession, frame: Frame, metrics: Any, db, redis) -> None:
    if TELEMETRY_METRICS_SCOPE not in session.scopes:
        return
    samples = metrics if isinstance(metrics, list) else [metrics]
    for sample in samples[-32:]:
        if isinstance(sample, dict) and sample:
            await new_metrics(db, redis, int(frame.id), sample)


async def _on_metrics(session: DeviceSession, message: dict[str, Any], redis) -> None:
    metrics = message.get("metrics")
    if not isinstance(metrics, (dict, list)):
        return
    if TELEMETRY_METRICS_SCOPE not in session.scopes:
        await _hub_ack(session, message.get("id"), "insufficient_scope")
        return
    if not _within_bytes(metrics, MAX_METRICS_BYTES):
        await _hub_ack(session, message.get("id"), "payload_too_large")
        return
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        if frame is None:
            return
        await _ingest_metrics(session, frame, metrics, db, redis)
    finally:
        db.close()


async def _on_sleep(session: DeviceSession, message: dict[str, Any], redis) -> None:
    """The device announces a deep sleep and hangs up: record its forecast
    (when it is back, when the panel next refreshes, why) and let it go."""
    wake_in = message.get("wake_in_seconds")
    now = _now()
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        if frame is not None:
            if isinstance(wake_in, (int, float)) and not isinstance(wake_in, bool) and 1 <= wake_in <= MAX_SLEEP_SECONDS:
                frame.next_wake_at = now + timedelta(seconds=float(wake_in))
            next_render = message.get("next_render_at")
            if isinstance(next_render, (int, float)) and not isinstance(next_render, bool):
                at = datetime.fromtimestamp(float(next_render), tz=timezone.utc).replace(tzinfo=None)
                if now - timedelta(hours=1) <= at <= now + timedelta(seconds=MAX_SLEEP_SECONDS):
                    frame.next_render_at = at
            reason = _str(message.get("reason"), 32)
            if reason:
                frame.sleep_reason = reason
            link = frame.provider_link
            if link is not None:
                link.last_seen_at = now
            db.commit()
    finally:
        db.close()
    await _disconnect(session, redis, "asleep")
    await _close(session, 1000, "asleep")


async def _on_render(session: DeviceSession, message: dict[str, Any], redis) -> None:
    """A render finished on the device: the deploy's last stage, and the
    workspace's cue to reload the frame's image."""
    active_scene = _str(message.get("active_scene"), MAX_SCENE_ID_CHARS)
    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        if frame is None:
            return
        moved = fold_deploy_progress(frame.deploy_progress, "render:done", now=_aware(_now()))
        if moved is not None:
            frame.deploy_progress = moved
        if frame.status != "ready":
            frame.status = "ready"
        db.commit()
        if active_scene:
            await redis.set(f"frame:{frame.id}:active_scene", active_scene)
        await update_frame(db, redis, frame)
        await publish_message(redis, "frame_rendered", {
            "project_id": frame.project_id,
            "frameId": frame.id,
            "sceneId": active_scene,
            "width": frame.width,
            "height": frame.height,
        })
    finally:
        db.close()


async def _on_assets(session: DeviceSession, message: dict[str, Any], redis) -> None:
    command_id = message.get("id")
    assets = message.get("assets")
    if not isinstance(command_id, str) or not isinstance(assets, list):
        return
    listing: list[dict[str, Any]] = []
    for entry in assets[:5000]:
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if not isinstance(path, str) or not path or len(path) > 1024 or path.startswith("/") or ".." in path.split("/"):
            continue
        item: dict[str, Any] = {"path": path}
        for key in ("size", "mtime"):
            if isinstance(entry.get(key), (int, float)) and not isinstance(entry.get(key), bool):
                item[key] = entry[key]
        if entry.get("is_dir") is True:
            item["is_dir"] = True
        listing.append(item)
    await store_provider_result(redis, command_id, {"assets": listing, "truncated": message.get("truncated") is True})


async def _on_asset_chunk(session: DeviceSession, message: dict[str, Any], redis) -> None:
    """One part of an asset_get / image_get / scenes_get reply, in order,
    reassembled in memory (8 MiB, four streams per frame at most)."""
    command_id = message.get("id")
    if not isinstance(command_id, str) or not command_id:
        return
    if isinstance(message.get("error"), str):
        session.streams.pop(command_id, None)
        await store_provider_result(redis, command_id, {"error": message["error"][:128]})
        return
    seq = message.get("seq")
    data = message.get("data", "")
    if not isinstance(seq, int) or isinstance(seq, bool) or not isinstance(data, str):
        return
    if seq == 0:
        if command_id not in session.streams and len(session.streams) >= MAX_ASSET_STREAMS:
            await store_provider_result(redis, command_id, {"error": "busy"})
            return
        session.streams[command_id] = AssetStream(content_type=_str(message.get("content_type"), 128))
    stream = session.streams.get(command_id)
    if stream is None or seq != stream.next_seq:
        session.streams.pop(command_id, None)
        await store_provider_result(redis, command_id, {"error": "chunk_out_of_order"})
        return
    try:
        part = base64.b64decode(data, validate=True) if data else b""
    except ValueError:
        session.streams.pop(command_id, None)
        await store_provider_result(redis, command_id, {"error": "invalid_data"})
        return
    stream.size += len(part)
    if stream.size > MAX_ASSET_BYTES:
        session.streams.pop(command_id, None)
        await store_provider_result(redis, command_id, {"error": "too_large"})
        return
    stream.chunks.append(part)
    stream.next_seq += 1
    stream.touched = time.monotonic()
    if message.get("done") is not True:
        return
    session.streams.pop(command_id, None)
    body = b"".join(stream.chunks)
    await store_provider_file(redis, command_id, body, stream.content_type)

    db = SessionLocal()
    try:
        frame = db.get(Frame, session.frame_id)
        command = get_frame_command(db, frame, command_id) if frame is not None else None
        if frame is None or command is None:
            return
        if command.type == "scenes_get":
            await _adopt_device_scenes(db, redis, frame, body)
        elif command.type == "image_get":
            from app.api.frames import _frame_image_cache_key

            await redis.set(_frame_image_cache_key(frame.id), body, ex=86400 * 30)
    finally:
        db.close()


async def _adopt_device_scenes(db, redis, frame: Frame, body: bytes) -> None:
    """The scenes a frame already ran when it enrolled become its scene
    list here, unless the owner has given it scenes since: what adopting a
    card does, and the cloud's "Import scenes from this frame" without the
    click (the backend has no scene library to import into)."""
    try:
        document = json.loads(body)
    except ValueError:
        return
    scenes = document.get("scenes") if isinstance(document, dict) else None
    if not isinstance(scenes, list) or not scenes:
        return
    db.refresh(frame)
    if isinstance(frame.scenes, list) and frame.scenes:
        return
    frame.scenes = [scene for scene in scenes if isinstance(scene, dict)]
    await update_frame(db, redis, frame)
    await new_log(
        db, redis, int(frame.id), "stdinfo",
        f"Imported the {len(frame.scenes)} scene{'' if len(frame.scenes) == 1 else 's'} the frame already ran",
    )


# --------------------------------------------------------------- endpoint

async def _deny(ws: WebSocket, status: int, error: str) -> None:
    await ws.send_denial_response(JSONResponse({"error": error}, status_code=status))


async def _authenticate_upgrade(ws: WebSocket, redis) -> Optional[DeviceSession]:
    if len(sessions) + _pending_sockets >= MAX_SESSIONS:
        await _deny(ws, 503, "too_many_connections")
        return None
    ip = client_ip_for_request(ws) or "unknown"
    if await hit_rate_limit(redis, "frame_hub_upgrade", ip, limit=UPGRADES_PER_MINUTE_PER_IP, window_seconds=60):
        await _deny(ws, 429, "rate_limited")
        return None
    authorization = ws.headers.get("authorization") or ""
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        await _deny(ws, 401, "invalid_link_token")
        return None
    db = SessionLocal()
    try:
        link = db.query(FrameProviderLink).filter_by(token_hash=hash_secret(parts[1])).first()
        if link is None:
            await _deny(ws, 401, "invalid_link_token")
            return None
        if link.status != "active" or link.revoked_at is not None:
            await _deny(ws, 401, "frame_revoked")
            return None
        if FRAME_MANAGED_SCOPE not in link.scope_list():
            await _deny(ws, 401, "insufficient_scope")
            return None
        if link.frame is None:
            await _deny(ws, 401, "frame_not_enrolled")
            return None
        return DeviceSession(
            ws=ws,
            frame_id=int(link.frame_id),
            project_id=int(link.project_id),
            link_id=link.id,
            public_key=link.public_key,
            token_hash=link.token_hash,
            scopes=link.scope_list(),
        )
    finally:
        db.close()


def _signature_valid(public_key: str, nonce: bytes, signature: Any) -> bool:
    if not isinstance(signature, str):
        return False
    try:
        raw_key = base64.b64decode(public_key, validate=True)
        raw_signature = base64.b64decode(signature, validate=True)
        if len(raw_key) != 32 or len(raw_signature) != 64:
            return False
        Ed25519PublicKey.from_public_bytes(raw_key).verify(raw_signature, nonce)
        return True
    except (ValueError, InvalidSignature):
        return False


async def _receive_json(ws: WebSocket, timeout: Optional[float]) -> Optional[dict[str, Any]] | str:
    """One text message as a JSON object; "closed" when the socket went,
    "too_big" past the cap, None for anything else (binary, not JSON)."""
    if timeout is not None:
        packet = await asyncio.wait_for(ws.receive(), timeout=timeout)
    else:
        packet = await ws.receive()
    if packet.get("type") == "websocket.disconnect":
        return "closed"
    text = packet.get("text")
    if text is None:
        return None
    if len(text) > MAX_MESSAGE_BYTES:
        return "too_big"
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


@router.websocket(DEVICE_PATH)
async def provider_frame_socket(ws: WebSocket):
    global _pending_sockets

    redis = get_shared_redis()
    session = await _authenticate_upgrade(ws, redis)
    if session is None:
        return
    await _ensure_background_tasks()
    _pending_sockets += 1
    reason = "connection_lost"
    try:
        await ws.accept()
        nonce = os.urandom(32)
        await ws.send_text(json.dumps({
            "id": str(uuid.uuid4()),
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "type": "challenge",
        }))
        hello: Optional[dict[str, Any]] = None
        signature: Any = None
        deadline = time.monotonic() + AUTH_TIMEOUT_SECONDS
        while hello is None or signature is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError
            message = await _receive_json(ws, remaining)
            if message == "closed":
                return
            if message == "too_big":
                await _close(session, CLOSE_TOO_BIG, "message_too_large")
                return
            if not isinstance(message, dict):
                continue
            if message.get("type") == "hello" and hello is None:
                hello = {key: message[key] for key in HELLO_FIELDS if key in message}
            elif message.get("type") == "auth" and signature is None:
                signature = message.get("signature")
                if not _signature_valid(session.public_key, nonce, signature):
                    await _close(session, CLOSE_AUTH_FAILED, "invalid_signature")
                    return
            # Anything else before `ready` is dropped.
    except asyncio.TimeoutError:
        await _close(session, CLOSE_AUTH_TIMEOUT, "auth_timeout")
        return
    except WebSocketDisconnect:
        return
    finally:
        _pending_sockets -= 1

    if not await _check_current(session):
        return
    try:
        await _activate(session, hello or {}, redis)
        while not session.closed:
            message = await _receive_json(ws, None)
            if message == "closed":
                break
            if message == "too_big":
                await _close(session, CLOSE_TOO_BIG, "message_too_large")
                break
            if not isinstance(message, dict):
                continue
            try:
                await _handle(session, message, redis)
            except Exception as exc:  # noqa: BLE001 - a bad message must not drop the frame
                logger.exception("provider hub: frame %s message %r failed: %s", session.frame_id, message.get("type"), exc)
    except WebSocketDisconnect:
        pass
    except RuntimeError:
        # Starlette raises this once the socket was closed under us (a
        # supersede, a revoke): the session is over either way.
        pass
    finally:
        if session.closed and reason == "connection_lost":
            reason = "closed"
        await _disconnect(session, redis, reason)
