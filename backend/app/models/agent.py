import secrets
from sqlalchemy import String, DateTime, Integer, ForeignKey, func
from sqlalchemy.orm import relationship, backref, mapped_column
from app.database import Base

class Agent(Base):
    """
    One physical device (the “agent”) that talks to us on /ws/agent.
    device_id is supplied by the device itself and never changes.
    server_key is generated server-side and sent back during handshake.
    """
    __tablename__ = "agent"

    device_id  = mapped_column(String(64), primary_key=True)
    server_key = mapped_column(String(64), nullable=False,
                               default=lambda: secrets.token_hex(32))
    last_seen  = mapped_column(DateTime,     nullable=False,
                               default=func.now(), onupdate=func.now())

    # optional – link to Frame row if you already have one
    frame_id   = mapped_column(Integer, ForeignKey("frame.id"), nullable=True)
    frame      = relationship("Frame", backref=backref("agent", uselist=False))
