"""Photo share links (docs/photos.md "Share links").

A token that gives read access to one folder of a project's photo library and
everything below it. Frames play an album through its link, so they never
need the owner's credentials. `path` follows the folder when it is moved or
renamed (app/utils/photos.py) and the row goes when the folder is deleted.
"""
from __future__ import annotations

import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

__all__ = ["PhotoShare"]


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


class PhotoShare(Base):
    __tablename__ = "photo_share"
    __table_args__ = (Index("ix_photo_share_project_id", "project_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, ForeignKey("project.id", ondelete="CASCADE"), nullable=False)
    token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    # Naive UTC, like the other tables.
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False, default=_utcnow)
