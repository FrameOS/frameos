"""The device side of the frame command queue: an ESP32 pulls its commands
and acks them, the way a cloud frame drains its socket.

Two routes, both bearer-authenticated with the frame's server API key like
every other `/embedded/*` pull (app/api/embedded_device.py):

`POST /frames/{id}/embedded/commands` — the device's hello and drain, once
per pass (after its scenes and settings pulls) and whenever the backend
nudges it. The body says what the device holds and shows:

    {"frameos_version": "2026.10.5", "active_scene": "…", "states": {…},
     "scenes_checksum": "\\"…\\"", "settings_etag": "\\"…\\""}

`states` is the active scene's state (the device keeps one scene resident)
and goes straight into the backend's states cache, so the workspace shows
what the frame shows without reaching the device. The two ETags are what the
device last pulled: when they match what the backend serves now, every
waiting deploy row (set_scenes / set_settings) is acked — that is how a deploy
to a sleeping frame is recorded on the wake that applied it, and never
before. The answer is the queue, oldest first, as command frames
(`{id, type, …}`, the cloud socket's shape), each now `sent`.

`POST /frames/{id}/embedded/commands/{command_id}/ack` — the device's
answer, the socket's ack shape (`{ok, error?}`), plus the scene and state it
shows afterwards when the verb changed them. A repeat ack is harmless.
"""
from __future__ import annotations

import json
import time
from http import HTTPStatus
from typing import Any

from arq import ArqRedis as Redis
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
# Underscored: app/api/__init__.py star-imports this module.
from datetime import datetime as _datetime, timezone as _timezone

from app.models.frame import Frame, record_successful_deploy, set_deploy_progress, update_frame
from app.models.frame_command import FrameCommand
from app.models.log import new_log
from app.redis import get_redis
from app.utils.deploy_progress import fold as fold_deploy_progress
from app.utils.deploy_progress import fold_command as fold_deploy_progress_command
from app.utils.embedded_commands import command_label
from app.utils.lan_access import mirror_lan_access, reported_lan_access
from app.utils.frame_commands import (
    ack_frame_command,
    ack_pull_backed_commands,
    deploy_commands_settled,
    deploy_id_of,
    deploy_rows_pending,
    deploy_snapshot_for,
    drain_frame_commands,
    frame_command_wire,
    pending_command_count,
    utcnow,
)

from . import api_public
from .embedded_device import _embedded_frame_from_bearer, embedded_scenes_etag, embedded_settings_etag

# A hello or an ack is a few hundred bytes; a scene's state a few KB. The
# device never sends more, so anything bigger is not the device.
MAX_BODY_BYTES = 64 * 1024
# The scene state kept per hello: the cloud caps a state push at 16 KB.
MAX_STATE_BYTES = 16 * 1024


async def _json_body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="Body too large")
    if not raw.strip():
        return {}
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Expected a JSON object")
    return body


def _str_field(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value else None


async def _remember_device_state(redis: Redis, frame: Frame, body: dict[str, Any]) -> None:
    """What the device says it shows, into the states cache the workspace
    reads (frames.py `/states`), marked fresh: the device just said so."""
    from .frames import _frame_states_cache_key, _write_frame_states_cache

    active_scene = _str_field(body, "active_scene")
    states = body.get("states")
    if active_scene:
        await redis.set(f"frame:{frame.id}:active_scene", active_scene)
    if not isinstance(states, dict):
        return
    if len(json.dumps(states, separators=(",", ":"))) > MAX_STATE_BYTES:
        return
    # The firmware reports the resident scene's state flat; the cache keeps
    # the Linux `/states` shape, state by scene id.
    if active_scene and not any(isinstance(value, dict) for value in states.values()):
        states = {active_scene: states}
    record = {"sceneId": active_scene or "", "states": states}
    await _write_frame_states_cache(redis, _frame_states_cache_key(frame.id), record, fetched_at=time.time())


async def _clear_sleep_forecast(db: Session, redis: Redis, frame: Frame) -> None:
    """The device is talking: whatever it forecast before its last sleep is
    spent (the cloud clears next_wake_at on connect the same way)."""
    if frame.next_wake_at is None and frame.next_render_at is None and frame.sleep_reason is None:
        return
    frame.next_wake_at = None
    frame.next_render_at = None
    frame.sleep_reason = None
    await update_frame(db, redis, frame)


async def _record_deploy_if_settled(db: Session, redis: Redis, frame: Frame, command: FrameCommand) -> None:
    """A deploy row acked: once every row of that deploy is, the snapshot it
    carried becomes the frame's deploy baseline — what the drawer compares
    the form against. Recorded here, on the device's own word, never when
    the deploy was queued."""
    deploy_id = deploy_id_of(command)
    if not deploy_id or not deploy_commands_settled(db, frame, deploy_id):
        return
    snapshot = deploy_snapshot_for(db, frame, deploy_id)
    if snapshot is None:
        return
    record_successful_deploy(frame, snapshot)
    if frame.status in ("deploying", "uninitialized"):
        frame.status = "ready"
    # The deploy's bar: every row pulled, the first render is what is left.
    settled = fold_deploy_progress(frame.deploy_progress, "commands:settled", now=_datetime.now(_timezone.utc))
    if settled is not None:
        frame.deploy_progress = settled
    await update_frame(db, redis, frame)
    await new_log(db, redis, int(frame.id), "stdinfo", "✅ The frame pulled the deploy; recorded as deployed")


async def _fold_deploy_progress_command(db: Session, redis: Redis, frame: Frame, command: FrameCommand) -> None:
    """A verb the device took or refused moves the frame's deploy_progress
    (the `command:acked:<type>` / `command:failed:<type>` signals of
    docs/deploy-progress-contract.json)."""
    moved = fold_deploy_progress_command(
        frame.deploy_progress, command.type, command.status,
        now=_datetime.now(_timezone.utc), error=command.error,
    )
    await set_deploy_progress(db, redis, frame, moved)


async def _note_outcome(db: Session, redis: Redis, frame: Frame, command: FrameCommand) -> None:
    label = command_label(command)
    if command.status == "acked":
        await new_log(db, redis, int(frame.id), "stdinfo", f"Frame applied: {label}")
    elif command.status == "failed":
        await new_log(db, redis, int(frame.id), "stderr", f"Frame refused: {label} ({command.error})")


async def _mirror_lan_access_after_ack(
    db: Session, redis: Redis, frame: Frame, command: FrameCommand, body: dict[str, Any], was_live: bool
) -> None:
    """The switch as the ack's state fields report it; for an ack without
    them (older firmware), what an applied lan_access_set set."""
    value = reported_lan_access(body)
    if value is None and was_live and command.type == "lan_access_set" and command.status == "acked":
        enabled = (command.payload or {}).get("enabled") if isinstance(command.payload, dict) else None
        value = enabled if isinstance(enabled, bool) else None
    await mirror_lan_access(db, redis, frame, value)


@api_public.post("/frames/{id:int}/embedded/commands")
async def api_embedded_device_commands(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    body = await _json_body(request)
    now = utcnow()

    await _remember_device_state(redis, frame, body)
    # The LAN access switch rides the hello's state fields: the row mirrors
    # the device (a `set allow_local_network` on the USB console included).
    await mirror_lan_access(db, redis, frame, reported_lan_access(body))

    # The cloud hello's name for it, and the older name this route first had.
    scenes_etag = _str_field(body, "scenes_checksum") or _str_field(body, "scenes_etag")
    settings_etag = _str_field(body, "settings_etag")
    acked = ack_pull_backed_commands(
        db,
        frame,
        scenes_current=None if scenes_etag is None else scenes_etag == embedded_scenes_etag(db, frame),
        settings_current=None if settings_etag is None else settings_etag == embedded_settings_etag(db, frame),
        now=now,
    )
    handed = drain_frame_commands(db, frame, now)
    db.commit()
    for command in acked:
        await _note_outcome(db, redis, frame, command)
        await _fold_deploy_progress_command(db, redis, frame, command)
        await _record_deploy_if_settled(db, redis, frame, command)
    await _clear_sleep_forecast(db, redis, frame)
    return {
        "commands": [frame_command_wire(command) for command in handed],
        "pending": pending_command_count(db, frame, now),
        # A deploy is waiting and the device does not hold it: pull the
        # scenes and settings now, whatever the device's own sync rules say
        # (a USB-pushed scene store skips the backend pull until a deploy).
        "sync": deploy_rows_pending(db, frame, now),
    }


@api_public.post("/frames/{id:int}/embedded/commands/{command_id}/ack")
async def api_embedded_device_command_ack(
    id: int,
    command_id: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    body = await _json_body(request)
    ok = body.get("ok")
    if not isinstance(ok, bool):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="ok must be a boolean")
    error = _str_field(body, "error")
    was_live = False
    command = db.get(FrameCommand, command_id)
    if command is not None and int(command.frame_id) == int(frame.id):
        was_live = command.status in ("pending", "sent")
    command = ack_frame_command(db, frame, command_id, ok=ok, error=error)
    if command is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Unknown command")
    db.commit()
    await _remember_device_state(redis, frame, body)
    await _mirror_lan_access_after_ack(db, redis, frame, command, body, was_live)
    if was_live:
        await _note_outcome(db, redis, frame, command)
        await _fold_deploy_progress_command(db, redis, frame, command)
        if command.type == "set_current_scene" and command.status == "acked":
            scene_id = frame_command_wire(command).get("scene_id")
            if isinstance(scene_id, str) and scene_id:
                await redis.set(f"frame:{frame.id}:active_scene", scene_id)
    return {"ok": True, "status": command.status}
