from datetime import datetime, timedelta
import secrets
import uuid

from sqlalchemy import String, DateTime, Integer, ForeignKey, func, text, UniqueConstraint
from sqlalchemy.orm import relationship, backref, mapped_column

from app.database import Base


class Agent(Base):
    """A physical device speaking the /ws/agent protocol."""

    __tablename__ = "agent"
    __table_args__ = (
        # Ensure each (org_id, batch_id, device_id) tuple is unique
        UniqueConstraint("org_id", "batch_id", "device_id", name="uq_agent_org_batch_device"),
    )

    # ------------------------------------------------------------------
    # Identifiers
    # ------------------------------------------------------------------
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    org_id = mapped_column(String(64), nullable=False)
    batch_id = mapped_column(String(64), nullable=False)
    device_id = mapped_column(String(64), nullable=False)

    # ------------------------------------------------------------------
    # Authentication key
    # ------------------------------------------------------------------
    server_key = mapped_column(String(64), nullable=False, default=lambda: secrets.token_hex(32))
    server_key_created_at = mapped_column(DateTime, nullable=True, default=func.now())
    server_key_revoked_at = mapped_column(DateTime, nullable=True)
    server_key_version = mapped_column(Integer, nullable=False, server_default=text("1"))

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------
    last_seen = mapped_column(DateTime, nullable=False, default=func.now(), onupdate=func.now())

    # Optional – link to Frame row if you already have one
    frame_id = mapped_column(Integer, ForeignKey("frame.id"), nullable=True)
    frame = relationship("Frame", backref=backref("agent", uselist=False))

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------

    KEY_LIFETIME = timedelta(days=90)

    def must_rotate_key(self) -> bool:
        """Return True when the authentication key should be rotated."""
        if self.server_key_revoked_at is not None:
            return True
        if datetime.now() - self.server_key_created_at > self.KEY_LIFETIME:
            return True
        return False

    def rotate_key(self):
        """Generate a new authentication key and reset related metadata."""
        self.server_key = secrets.token_hex(32)
        self.server_key_created_at = datetime.now()
        self.server_key_revoked_at = None
        self.server_key_version = (self.server_key_version or 0) + 1
