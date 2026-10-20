"""Frames this backend manages as their provider (docs/cloud-frames.md).

A frame enrolled with a claim token against this backend's URL dials the
same outbound management WebSocket it would dial on FrameOS Cloud
(`/api/frames/ws`): Bearer link token, Ed25519 challenge, `ready`, the
contract's verbs. That is item 7 of docs/convergence-todo.md, Stage 1: the
backend hosts the provider protocol, so a cloud-enrolled frame pointed at a
backend URL behaves identically.

Two rows, the cloud's `linked_clients` + `frames` pair folded down:

- FrameProviderLink, one per provider-managed frame: the device's public key
  (the frame generated the keypair; nothing here can sign as it), the SHA-256
  of its link token (never the token), the scopes the link grants, and what
  the device last said over the socket. A frame row WITH a live link is a
  provider frame (app/utils/provider_frames.py is_provider_frame): every
  route reaches it through the command queue and never over SSH, the Remote
  or its admin API.
- FrameClaimToken, minted by "Add frame -> Connect with a claim code": the
  hash of a single-use `FRCT_` token with a short expiry. Redeeming one at
  `POST /api/frames/enroll` creates the frame (or, for a token bound to a
  frame, re-keys it) and spends the token.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import mapped_column, relationship

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class FrameProviderLink(Base):
    __tablename__ = "frame_provider_link"

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    frame_id = mapped_column(Integer, ForeignKey("frame.id", ondelete="CASCADE"), nullable=False, unique=True)
    # base64 of the raw 32-byte Ed25519 public key the device sent at enrollment.
    public_key = mapped_column(Text, nullable=False)
    # base64url SHA-256 of the link token (the cloud's hashSecret): what the
    # device's `Authorization: Bearer` is looked up by.
    token_hash = mapped_column(String(64), nullable=False, unique=True)
    # Space-separated, the enrollment response's `scope`.
    scopes = mapped_column(Text, nullable=False, default="")
    # active | revoked. Every enrollment here is a single-use claim token's,
    # which the cloud bears active too: the owner minted it for one device.
    status = mapped_column(String(16), nullable=False, default="active")
    created_at = mapped_column(DateTime, nullable=False, default=_utcnow)
    revoked_at = mapped_column(DateTime, nullable=True)
    # Where a browser on the LAN reaches the device's own admin page.
    local_origin = mapped_column(String(512), nullable=True)

    # What the device last said over the socket. `session_id` names the
    # socket that wrote `connected`, so a late disconnect of a superseded
    # socket never marks the frame offline under the live one.
    connected = mapped_column(Boolean, nullable=False, default=False)
    session_id = mapped_column(String(36), nullable=True)
    last_seen_at = mapped_column(DateTime, nullable=True)
    frameos_version = mapped_column(String(64), nullable=True)
    hardware = mapped_column(JSON, nullable=True)
    last_state = mapped_column(JSON, nullable=True)
    scenes_checksum = mapped_column(String(128), nullable=True)

    frame = relationship("Frame", back_populates="provider_link")

    def scope_list(self) -> list[str]:
        return [scope for scope in (self.scopes or "").split() if scope]


class FrameClaimToken(Base):
    __tablename__ = "frame_claim_token"

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    token_hash = mapped_column(String(64), nullable=False, unique=True)
    # A token bound to a frame re-keys that frame (a board that lost its
    # keys comes back as the same frame); unbound, it creates one.
    frame_id = mapped_column(Integer, ForeignKey("frame.id", ondelete="CASCADE"), nullable=True)
    # The new frame's name, when the owner gave one at minting.
    name = mapped_column(String(256), nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=_utcnow)
    expires_at = mapped_column(DateTime, nullable=False)
    used_at = mapped_column(DateTime, nullable=True)
    # Which public key spent it: a retry of the same enrollment (a response
    # lost in flight) gets the same frame back instead of a refusal.
    used_public_key = mapped_column(Text, nullable=True)
    used_frame_id = mapped_column(Integer, ForeignKey("frame.id", ondelete="SET NULL"), nullable=True)


def frame_provider_link(frame: Any) -> Optional[FrameProviderLink]:
    """The frame's link, however the frame object came to the caller.

    The relationship loads on access (never joined: the data migrations that
    query Frame run before the table exists), and a Frame whose session has
    closed cannot load it — the Remote's socket and the deploy jobs hand such
    rows around. A detached row is answered with a short query of its own; a
    stand-in (the deploy plan's SimpleNamespace preview) carries the link as
    a plain attribute."""
    state = sa_inspect(frame, raiseerr=False)
    if state is None:
        link = getattr(frame, "provider_link", None)
        return link if isinstance(link, FrameProviderLink) else None
    if state.detached and "provider_link" in state.unloaded:
        from app.database import SessionLocal

        session = SessionLocal()
        try:
            link = session.query(FrameProviderLink).filter_by(frame_id=frame.id).first()
            if link is not None:
                session.expunge(link)
            return link
        finally:
            session.close()
    link = frame.provider_link
    return link if isinstance(link, FrameProviderLink) else None
