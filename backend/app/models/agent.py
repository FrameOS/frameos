from datetime import datetime, timedelta, timezone
import secrets
from sqlalchemy import String, DateTime, Integer, ForeignKey, func
from sqlalchemy.orm import relationship, backref, mapped_column
from app.database import Base

class Agent(Base):
    """A physical device speaking the /ws/agent protocol."""

    __tablename__ = "agent"

    device_id  = mapped_column(String(64), primary_key=True)
    server_key = mapped_column(String(64), nullable=False,
                               default=lambda: secrets.token_hex(32))

    server_key_created_at = mapped_column(DateTime, nullable=False, default=func.now())
    server_key_revoked_at = mapped_column(DateTime, nullable=True)
    server_key_version    = mapped_column(Integer,  nullable=False, default=1)

    last_seen  = mapped_column(DateTime,     nullable=False,
                               default=func.now(), onupdate=func.now())

    # optional – link to Frame row if you already have one
    frame_id   = mapped_column(Integer, ForeignKey("frame.id"), nullable=True)
    frame      = relationship("Frame", backref=backref("agent", uselist=False))

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------

    KEY_LIFETIME = timedelta(days=90)

    def must_rotate_key(self) -> bool:
        if self.server_key_revoked_at is not None:
            return True
        if datetime.now(timezone.utc) - self.server_key_created_at > self.KEY_LIFETIME:
            return True
        return False

    def rotate_key(self):
        self.server_key = secrets.token_hex(32)
        self.server_key_created_at = datetime.now(timezone.utc)
        self.server_key_revoked_at = None
        self.server_key_version += 1
