"""The photo library's rows (docs/photos.md), the cloud's `photo_entries`
table with a project in place of an account.

One row per file AND per folder: a folder row is what lets an empty album
exist, and every row's parent folder has a row of its own (the root "" has
none). `path` is relative to the library root, `/`-separated, validated by
app/utils/photos.py. The bytes are not here: `object_key` names them in the
object store (app/utils/object_store.py), content addressed as
`photos/<sha256>`, so two uploads of one photo share one object and a row
never holds a file name the disk has to agree with.
"""
from __future__ import annotations

import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

__all__ = ["PhotoEntry"]


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


class PhotoEntry(Base):
    __tablename__ = "photo_entry"
    __table_args__ = (
        UniqueConstraint("project_id", "path", name="uq_photo_entry_project_path"),
        Index("ix_photo_entry_project_id", "project_id"),
        Index("ix_photo_entry_object_key", "object_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id", ondelete="CASCADE"), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    # file | folder
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Files: the stored bytes. Folders: 0 (their size is summed on read).
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # From the file's name on the backend (any file can be stored).
    content_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    thumb_object_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # ready (the cloud also has blocked, for a scan match)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ready")
    # Files only: the color profile (docs/photos.md "Colors"), or null.
    colors: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Naive UTC, like the other tables. updated_at is bumped whenever the
    # entry or (for folders) something directly inside it changes, so a
    # share link's listing can say when its album last changed.
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False, default=_utcnow)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False, default=_utcnow)
