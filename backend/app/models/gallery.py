import os
import shutil
import uuid
from pathlib import Path

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import backref, mapped_column, relationship

from app.database import Base


class Gallery(Base):
    __tablename__ = "gallery"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    name = mapped_column(String(255), nullable=False)
    description = mapped_column(Text, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    images = relationship(
        "GalleryImage",
        cascade="all, delete-orphan",
        passive_deletes=True,
        backref=backref("gallery", lazy=True),
        lazy="selectin",
    )

    def to_dict(self, image_count: int | None = None):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "image_count": image_count if image_count is not None else len(self.images or []),
        }


class GalleryImage(Base):
    __tablename__ = "gallery_image"

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    gallery_id = mapped_column(Integer, ForeignKey("gallery.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = mapped_column(String(512), nullable=False)
    original_path = mapped_column(String(1024), nullable=False)
    thumbnail_path = mapped_column(String(1024), nullable=True)
    mime_type = mapped_column(String(128), nullable=True)
    extension = mapped_column(String(16), nullable=True)
    width = mapped_column(Integer, nullable=True)
    height = mapped_column(Integer, nullable=True)
    file_size = mapped_column(Integer, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    def to_dict(self):
        return {
            "id": self.id,
            "gallery_id": self.gallery_id,
            "filename": self.filename,
            "mime_type": self.mime_type,
            "extension": self.extension,
            "width": self.width,
            "height": self.height,
            "file_size": self.file_size,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


def remove_gallery_directory(base_path: Path, gallery_id: int):
    gallery_path = base_path / str(gallery_id)
    if gallery_path.exists():
        shutil.rmtree(gallery_path, ignore_errors=True)


def remove_image_files(base_path: Path, image: "GalleryImage"):
    gallery_path = base_path / str(image.gallery_id)
    original_path = gallery_path / image.original_path
    if original_path.exists():
        original_path.unlink(missing_ok=True)

    if image.thumbnail_path:
        thumb_path = gallery_path / image.thumbnail_path
        if thumb_path.exists():
            thumb_path.unlink(missing_ok=True)

    cache_path = gallery_path / "cache"
    if cache_path.exists():
        for root, _, files in os.walk(cache_path):
            for file in files:
                if file.startswith(image.id):
                    try:
                        Path(root, file).unlink()
                    except FileNotFoundError:
                        pass
