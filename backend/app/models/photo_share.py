"""Photo share links (docs/photos.md "Share links").

A token that gives read access to one folder of a project's photo library and
everything below it. Frames play an album through its link, so they never
need the owner's credentials. `path` follows the folder when it is moved or
renamed (app/utils/photos.py) and the row goes when the folder is deleted.

A folder may have several links: one for anyone (`frame_id` and `name`
NULL), one per frame it was installed on (`frame_id` the frame's id) and any
number of custom ones (`name` what the owner called it, "Grandma"), so one
link's access can be withdrawn on its own. The frame id is a plain column,
not a foreign key: a deleted frame leaves its link behind to be seen and
removed. `last_used_at` moves when a frame (or anyone) reads through the
link, at most once a minute.
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
    frame_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_used_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(), nullable=True)
    # Naive UTC, like the other tables.
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False, default=_utcnow)
