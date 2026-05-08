import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Session, mapped_column

from app.database import Base


class AiEmbedding(Base):
    __tablename__ = "ai_embeddings"
    __table_args__ = (
        UniqueConstraint("source_type", "source_path", name="uq_ai_embeddings_source"),
    )

    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_type = mapped_column(String(32), nullable=False)
    source_path = mapped_column(Text, nullable=False)
    name = mapped_column(String(256), nullable=True)
    summary = mapped_column(Text, nullable=False)
    embedding = mapped_column(JSON, nullable=False)
    metadata_json = mapped_column("metadata", JSON, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    updated_at = mapped_column(
        DateTime,
        nullable=False,
        default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_type": self.source_type,
            "source_path": self.source_path,
            "name": self.name,
            "summary": self.summary,
            "embedding": self.embedding,
            "metadata": self.metadata_json,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


def upsert_ai_embedding(
    db: Session,
    *,
    source_type: str,
    source_path: str,
    name: Optional[str],
    summary: str,
    embedding: list[float],
    metadata: Optional[dict[str, Any]],
) -> AiEmbedding:
    existing = (
        db.query(AiEmbedding)
        .filter_by(source_type=source_type, source_path=source_path)
        .one_or_none()
    )
    if existing:
        existing.name = name
        existing.summary = summary
        existing.embedding = embedding
        existing.metadata_json = metadata
        existing.updated_at = datetime.utcnow()
        db.add(existing)
        return existing

    entry = AiEmbedding(
        source_type=source_type,
        source_path=source_path,
        name=name,
        summary=summary,
        embedding=embedding,
        metadata_json=metadata,
    )
    db.add(entry)
    return entry
