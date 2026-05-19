from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def expires_in(minutes: int) -> datetime:
    return utcnow() + timedelta(minutes=minutes)


def random_prefixed_id(prefix: str, bytes_count: int = 18) -> str:
    return f"{prefix}_{secrets.token_urlsafe(bytes_count)}"


class CloudAuthSession(Base):
    __tablename__ = "cloud_auth_session"

    id = mapped_column(Integer, primary_key=True)
    state_hash = mapped_column(String(128), nullable=False, unique=True)
    purpose = mapped_column(String(32), nullable=False)
    user_id = mapped_column(Integer, ForeignKey("user.id"), nullable=True)
    backend_name = mapped_column(String(256), nullable=False)
    backend_url = mapped_column(String(1024), nullable=False)
    redirect_uri = mapped_column(String(1024), nullable=False)
    return_to = mapped_column(String(2048), nullable=True)
    pending_email = mapped_column(String(120), nullable=True)
    pending_password_hash = mapped_column(String(256), nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at = mapped_column(DateTime, nullable=False)
    consumed_at = mapped_column(DateTime, nullable=True)

    def is_active(self) -> bool:
        return self.consumed_at is None and self.expires_at > utcnow()


class CloudExportObject(Base):
    __tablename__ = "cloud_export_object"

    id = mapped_column(String(80), primary_key=True, default=lambda: random_prefixed_id("obj"))
    kind = mapped_column(String(64), nullable=False)
    locator = mapped_column(JSON, nullable=False)
    content_type = mapped_column(String(256), nullable=True)
    size = mapped_column(Integer, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at = mapped_column(DateTime, nullable=False)

    def to_manifest_dict(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "contentType": self.content_type or "application/octet-stream",
            "size": self.size,
            **(extra or {}),
        }


class CloudImportSession(Base):
    __tablename__ = "cloud_import_session"

    id = mapped_column(String(80), primary_key=True, default=lambda: random_prefixed_id("imp"))
    manifest = mapped_column(JSON, nullable=False)
    status = mapped_column(String(32), nullable=False, default="prepared")
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at = mapped_column(DateTime, nullable=False)
    committed_at = mapped_column(DateTime, nullable=True)
    error = mapped_column(Text, nullable=True)


class CloudImportObject(Base):
    __tablename__ = "cloud_import_object"

    id = mapped_column(Integer, primary_key=True)
    session_id = mapped_column(String(80), ForeignKey("cloud_import_session.id"), nullable=False)
    object_id = mapped_column(String(160), nullable=False)
    content_type = mapped_column(String(256), nullable=True)
    data = mapped_column(LargeBinary, nullable=False)
    created_at = mapped_column(DateTime, nullable=False, default=utcnow)
