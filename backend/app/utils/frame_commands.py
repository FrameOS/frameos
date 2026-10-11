"""The frame command queue's rules: the cloud's, ported.

What FrameOS Cloud does in cloud/apps/auth-web/src/lib/frames.ts
(enqueueFrameCommand, supersedePendingCommands, listPendingFrameCommands,
cancelFrameCommand), cloud/apps/auth-web/src/lib/frame-sleep.ts
(commandTtlForFrame) and cloud/apps/frame-hub/src/hub.ts (expireStaleCommands,
redeliverSentCommands, the drain) for a frame on its management socket, the
self-hosted backend does here for an ESP32 on its HTTP pulls. One queue, one
set of rules, so the workspace's "Waiting for the frame" panel means the same
thing on both control planes (docs/cloud-frames.md, "Queue observability").

Delivery is at-least-once: a command the device never acked is handed over
again on a later pull, so the device applies each id once (it remembers the
ids it ran, fos_commands.c). The exceptions are delivered at most once —
`reboot`, `restart_runtime` and `notify_update_available`, because the
disconnect that follows is their expected effect, and `scene_event`, because
a button press delivered twice turns two pages.

Everything here is a plain database function: no HTTP, no redis, no
device. Reaching the device (the nudge, the wait for an ack) is
app/utils/embedded_commands.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.frame_command import FrameCommand

# --------------------------------------------------------------------- rules

# Action verbs are short-lived on purpose: a reboot queued on Monday must
# not fire on Friday. Same base TTL as the cloud's commandTtlMs; a sleeping
# frame's TTL stretches past its announced wake (command_ttl_for_frame).
COMMAND_TTL_SECONDS = 5 * 60
# A firmware update notice keeps for a day (the cloud's updateNotifyTtlMs).
UPDATE_NOTIFY_TTL_SECONDS = 24 * 60 * 60
# The firmware caps one sleep at 7 days; an hour covers wake alignment.
MAX_SLEEP_WAIT_SECONDS = 7 * 86400 + 3600
# A command written to the device but never acked goes back to pending and
# is handed over again — once the device has had this long to answer. The
# cloud's commandRedeliverAfterMs.
REDELIVER_AFTER_SECONDS = 180

# Written once, never resent (docs/cloud-frames.md, "delivery guarantees").
DELIVERED_ONCE_TYPES: frozenset[str] = frozenset(
    {"reboot", "restart_runtime", "notify_update_available", "scene_event"}
)
# A newer command of the same type replaces the older one still waiting:
# two queued scene switches are one switch, two deploys one deploy. Not
# scene_event: two presses are two presses.
SUPERSEDED_TYPES: frozenset[str] = frozenset(
    {
        "set_scenes",
        "set_settings",
        "set_current_scene",
        "notify_update_available",
        "render",
        "reboot",
        "restart_runtime",
    }
)
# Never handed to the device as a verb: the device already pulls its scenes
# and settings on every pass (`/embedded/scenes`, `/embedded/settings`), so
# a deploy is recorded here as the intention and acked by the checksum the
# device reports holding on its next pull (ack_pull_backed_commands).
PULL_BACKED_TYPES: frozenset[str] = frozenset({"set_scenes", "set_settings"})
# Every verb the backend may queue; anything else is a programming error,
# not something to hand a device that would answer unknown_verb.
QUEUEABLE_TYPES: frozenset[str] = frozenset(
    {
        "render",
        "reboot",
        "restart_runtime",
        "set_current_scene",
        "scene_event",
        "notify_update_available",
        "set_scenes",
        "set_settings",
    }
)
# No TTL: a deploy waits for the frame however long it sleeps (the cloud's
# set_scenes / set_settings pushes carry none either).
_NO_TTL_TYPES: frozenset[str] = PULL_BACKED_TYPES

LIVE_STATUSES: tuple[str, ...] = ("pending", "sent")


def utcnow() -> datetime:
    """Naive UTC, the way every DateTime column in this backend is stored."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def base_ttl_seconds(command_type: str) -> int | None:
    if command_type in _NO_TTL_TYPES:
        return None
    if command_type == "notify_update_available":
        return UPDATE_NOTIFY_TTL_SECONDS
    return COMMAND_TTL_SECONDS


def command_ttl_for_frame(
    frame: Frame, base_ttl: int | None, now: datetime | None = None
) -> datetime | None:
    """When a command queued now should expire for this frame.

    A frame that is asleep cannot see the command until it wakes: a 5-minute
    TTL on a frame that sleeps 15 minutes expires every time. So the TTL
    reaches past the announced wake (`next_wake_at`, from the device's own
    sleep line) by the base TTL, and is the base TTL alone for an awake frame
    or one with no forecast. The cloud's commandTtlForFrame."""
    if base_ttl is None:
        return None
    now = now or utcnow()
    wake_at = _naive_utc(getattr(frame, "next_wake_at", None))
    if wake_at is None or wake_at <= now:
        return now + timedelta(seconds=base_ttl)
    wait = min((wake_at - now).total_seconds(), MAX_SLEEP_WAIT_SECONDS)
    return now + timedelta(seconds=wait + base_ttl)


def frame_is_asleep(frame: Frame, now: datetime | None = None) -> bool:
    """Is the frame's own forecast saying it is asleep right now?"""
    now = now or utcnow()
    wake_at = _naive_utc(getattr(frame, "next_wake_at", None))
    return wake_at is not None and wake_at > now


# ------------------------------------------------------------------- queries

def _live_rows(db: Session, frame: Frame):
    return (
        db.query(FrameCommand)
        .filter(FrameCommand.frame_id == int(frame.id), FrameCommand.status.in_(LIVE_STATUSES))
        .order_by(FrameCommand.created_at.asc(), FrameCommand.id.asc())
    )


def _expired_filter(now: datetime):
    return and_(FrameCommand.expires_at.isnot(None), FrameCommand.expires_at < now)


def get_frame_command(db: Session, frame: Frame, command_id: str) -> FrameCommand | None:
    if not isinstance(command_id, str) or not command_id:
        return None
    command = db.get(FrameCommand, command_id)
    if command is None or int(command.frame_id) != int(frame.id):
        return None
    return command


def pending_command_count(db: Session, frame: Frame, now: datetime | None = None) -> int:
    now = now or utcnow()
    return (
        _live_rows(db, frame)
        .filter(or_(FrameCommand.expires_at.is_(None), FrameCommand.expires_at >= now))
        .count()
    )


# ------------------------------------------------------------------- writes

def supersede_pending_commands(db: Session, frame: Frame, command_type: str, now: datetime | None = None) -> int:
    """Expire every live command of this type: the one being queued replaces
    them (a `sent` one too — written but never acked, it would otherwise be
    redelivered ahead of the newer one)."""
    now = now or utcnow()
    count = 0
    for row in _live_rows(db, frame).filter(FrameCommand.type == command_type).all():
        row.status = "expired"
        row.error = "superseded"
        count += 1
    db.flush()
    return count


def enqueue_frame_command(
    db: Session,
    frame: Frame,
    command_type: str,
    payload: dict[str, Any] | None = None,
    *,
    detail: str | None = None,
    ttl_seconds: int | None = None,
    now: datetime | None = None,
) -> FrameCommand:
    """Queue one command for the frame. Commits.

    `ttl_seconds` overrides the type's base TTL (never the no-TTL of a
    deploy); the deadline is then sized to the frame's sleep forecast."""
    if command_type not in QUEUEABLE_TYPES:
        raise ValueError(f"Not a queueable frame command: {command_type}")
    if payload is not None and not isinstance(payload, dict):
        raise ValueError("A frame command payload must be an object")
    now = now or utcnow()
    if command_type in SUPERSEDED_TYPES:
        supersede_pending_commands(db, frame, command_type, now)
    base_ttl = base_ttl_seconds(command_type)
    if ttl_seconds is not None and base_ttl is not None:
        base_ttl = int(ttl_seconds)
    command = FrameCommand(
        project_id=int(frame.project_id),
        frame_id=int(frame.id),
        type=command_type,
        payload=dict(payload) if payload else None,
        status="pending",
        detail=detail,
        created_at=now,
        expires_at=command_ttl_for_frame(frame, base_ttl, now),
    )
    db.add(command)
    db.commit()
    db.refresh(command)
    return command


def expire_stale_commands(db: Session, frame: Frame, now: datetime | None = None) -> int:
    """Rows past their TTL, pending or sent (a sent one is retried, so its
    TTL still counts). Does not commit."""
    now = now or utcnow()
    count = 0
    for row in _live_rows(db, frame).filter(_expired_filter(now)).all():
        row.status = "expired"
        row.error = "ttl"
        count += 1
    db.flush()
    return count


def cancel_frame_command(db: Session, frame: Frame, command_id: str, now: datetime | None = None) -> bool:
    """Take a command back off the queue while it is still waiting. The same
    terminal state a superseded command gets, with `cancelled` in `error`,
    so the row keeps saying what happened. False when there is nothing to
    cancel: already delivered and acked, already expired, already cancelled.
    Commits."""
    now = now or utcnow()
    command = get_frame_command(db, frame, command_id)
    if command is None or command.status not in LIVE_STATUSES:
        return False
    if command.expires_at is not None and command.expires_at < now:
        return False
    command.status = "expired"
    command.error = "cancelled"
    db.commit()
    return True


def drain_frame_commands(db: Session, frame: Frame, now: datetime | None = None) -> list[FrameCommand]:
    """What the device takes on this pull, oldest first, now marked `sent`.

    Mirrors the hub's drain on a session start: expire what ran out, requeue
    what was written long enough ago without an ack (or retire it, for the
    at-most-once verbs), then hand over everything pending. Pull-backed rows
    (a deploy) are never handed over; the device's checksums ack those
    (ack_pull_backed_commands). Does not commit."""
    now = now or utcnow()
    expire_stale_commands(db, frame, now)
    cutoff = now - timedelta(seconds=REDELIVER_AFTER_SECONDS)
    for row in _live_rows(db, frame).filter(FrameCommand.status == "sent").all():
        if row.sent_at is not None and row.sent_at > cutoff:
            continue  # still inside the device's answer window
        if row.type in DELIVERED_ONCE_TYPES:
            row.status = "expired"
            row.error = "delivered_once"
        else:
            row.status = "pending"
            row.sent_at = None
    db.flush()
    handed: list[FrameCommand] = []
    for row in _live_rows(db, frame).filter(FrameCommand.status == "pending").all():
        if row.type in PULL_BACKED_TYPES:
            continue
        row.status = "sent"
        row.sent_at = now
        handed.append(row)
    db.flush()
    return handed


def ack_frame_command(
    db: Session,
    frame: Frame,
    command_id: str,
    *,
    ok: bool,
    error: str | None = None,
    now: datetime | None = None,
) -> FrameCommand | None:
    """The device's answer by command id. A repeat ack of a finished command
    changes nothing (the device may answer the same id twice; at-least-once
    delivery promises that). Does not commit."""
    now = now or utcnow()
    command = get_frame_command(db, frame, command_id)
    if command is None:
        return None
    if command.status not in LIVE_STATUSES:
        return command
    command.status = "acked" if ok else "failed"
    command.error = None if ok else (error or "failed")
    command.acked_at = now
    return command


def ack_pull_backed_commands(
    db: Session,
    frame: Frame,
    *,
    scenes_current: bool | None,
    settings_current: bool | None,
    now: datetime | None = None,
) -> list[FrameCommand]:
    """A deploy is applied when the device holds what the backend serves: the
    device reports the ETags it last pulled, the caller compares them with
    the current payloads, and every waiting set_scenes / set_settings row is
    acked on a match. None = the device said nothing about that pull (older
    firmware) — leave the rows. Does not commit."""
    now = now or utcnow()
    acked: list[FrameCommand] = []
    for row in _live_rows(db, frame).filter(FrameCommand.type.in_(tuple(PULL_BACKED_TYPES))).all():
        current = scenes_current if row.type == "set_scenes" else settings_current
        if not current:
            continue
        row.status = "acked"
        row.error = None
        row.acked_at = now
        acked.append(row)
    db.flush()
    return acked


# ------------------------------------------------------------------ shapes

def _wire_payload(command: FrameCommand) -> dict[str, Any]:
    payload = command.payload if isinstance(command.payload, dict) else {}
    return {key: value for key, value in payload.items() if not str(key).startswith("_")}


def frame_command_wire(command: FrameCommand) -> dict[str, Any]:
    """The verb as the device receives it: `{id, type, ...payload}`, the
    cloud socket's command frame."""
    return {**_wire_payload(command), "id": command.id, "type": command.type}


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat()


def frame_command_public(command: FrameCommand) -> dict[str, Any]:
    """What the owner sees of a queued command (GET /frames/{id}/commands).

    Payloads are deliberately not echoed — a set_scenes payload is a whole
    scene bundle. Only set_current_scene's scene id is small and meaningful
    enough to report; `detail` is the backend's one-line addition."""
    out: dict[str, Any] = {
        "id": command.id,
        "type": command.type,
        "status": command.status,
        "created_at": _iso(command.created_at),
        "expires_at": _iso(command.expires_at),
        "sent_at": _iso(command.sent_at),
    }
    if command.type == "set_current_scene":
        scene_id = _wire_payload(command).get("scene_id")
        if isinstance(scene_id, str) and scene_id:
            out["scene_id"] = scene_id
    if command.detail:
        out["detail"] = command.detail
    return out


def list_pending_frame_commands(db: Session, frame: Frame, now: datetime | None = None) -> list[dict[str, Any]]:
    """What is still waiting, oldest first — the order the device takes it
    in. Rows past their TTL are filtered out, not swept: reading the queue
    must not change it."""
    now = now or utcnow()
    rows = (
        _live_rows(db, frame)
        .filter(or_(FrameCommand.expires_at.is_(None), FrameCommand.expires_at >= now))
        .all()
    )
    return [frame_command_public(row) for row in rows]


def deploy_rows_pending(db: Session, frame: Frame, now: datetime | None = None) -> bool:
    """Is a deploy (a pull-backed row) still waiting for the frame?"""
    now = now or utcnow()
    return (
        _live_rows(db, frame)
        .filter(FrameCommand.type.in_(tuple(PULL_BACKED_TYPES)))
        .filter(or_(FrameCommand.expires_at.is_(None), FrameCommand.expires_at >= now))
        .count()
        > 0
    )


def deploy_commands_settled(db: Session, frame: Frame, deploy_id: str) -> bool:
    """True once no live row of this deploy remains: the moment to record the
    deploy as the frame's baseline (the rows carry `_deploy.id`)."""
    for row in _live_rows(db, frame).filter(FrameCommand.type.in_(tuple(PULL_BACKED_TYPES))).all():
        if deploy_id_of(row) == deploy_id:
            return False
    return True


def deploy_snapshot_for(db: Session, frame: Frame, deploy_id: str) -> Optional[dict[str, Any]]:
    """The frame snapshot a deploy carries (on its set_scenes row only — it
    holds the scenes, so it is not stored twice), whatever state its rows
    are in by now."""
    rows = (
        db.query(FrameCommand)
        .filter(FrameCommand.frame_id == int(frame.id), FrameCommand.type.in_(tuple(PULL_BACKED_TYPES)))
        .all()
    )
    for row in rows:
        if deploy_id_of(row) != deploy_id:
            continue
        deploy = _deploy_of(row)
        snapshot = deploy.get("snapshot") if deploy else None
        if isinstance(snapshot, dict):
            return snapshot
    return None


def _deploy_of(command: FrameCommand) -> dict[str, Any] | None:
    payload = command.payload if isinstance(command.payload, dict) else {}
    deploy = payload.get("_deploy")
    return deploy if isinstance(deploy, dict) else None


def deploy_id_of(command: FrameCommand) -> str | None:
    deploy = _deploy_of(command)
    if not deploy:
        return None
    deploy_id = deploy.get("id")
    return deploy_id if isinstance(deploy_id, str) and deploy_id else None
