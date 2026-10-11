"""The per-frame command queue: what the backend is waiting for a frame to do.

Cloud parity. FrameOS Cloud keeps every verb it sends a frame as a row in
`frame_commands` (cloud/packages/db/src/schema.ts) and drains the queue when
the frame connects; the workspace's "Waiting for the frame" panel reads it
(docs/cloud-frames.md, "Queue observability"). This is the same table for the
self-hosted backend. An ESP32 that deep-sleeps between renders is a fresh
boot on every wake and cannot be pushed to while it sleeps, so a scene
switch, a scene state, a render, a reboot, a firmware update and a deploy
are recorded here and handed over on the device's next pull
(app/api/embedded_device.py, `POST /embedded/commands`), acked by command
id like over the cloud socket.

The lifecycle is the cloud's, word for word: pending -> sent -> acked |
failed, or expired (`error` says why: the TTL ran out, a newer command of
the same type superseded it, the owner cancelled it, or an at-most-once verb
was written once and is not resent). The semantics live in
app/utils/frame_commands.py; this file is the row.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class FrameCommand(Base):
    __tablename__ = "frame_command"
    __table_args__ = (
        Index("ix_frame_command_frame_status_created", "frame_id", "status", "created_at"),
    )

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    frame_id = mapped_column(ForeignKey("frame.id"), nullable=False, index=True)
    # A verb from docs/cloud-frames-contract.json (set_current_scene,
    # scene_event, render, reboot, restart_runtime, notify_update_available,
    # set_scenes, set_settings, ...). The device answers unknown_verb to
    # anything else, so nothing else is ever queued.
    type = mapped_column(String(64), nullable=False)
    # The verb's fields, minus `id` and `type`. Keys starting with "_" are
    # the backend's own bookkeeping (a deploy snapshot to record on ack) and
    # never leave the backend.
    payload = mapped_column(JSON, nullable=True)
    # pending | sent | acked | failed | expired
    status = mapped_column(String(16), nullable=False, default="pending")
    error = mapped_column(Text, nullable=True)
    # One line for the "Waiting for the frame" panel ("12 scenes", a scene's
    # name); the cloud's types speak for themselves, the backend adds this.
    detail = mapped_column(Text, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=_utcnow)
    expires_at = mapped_column(DateTime, nullable=True)
    sent_at = mapped_column(DateTime, nullable=True)
    acked_at = mapped_column(DateTime, nullable=True)
