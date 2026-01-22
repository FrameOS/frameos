from uuid import uuid4
from sqlalchemy import Integer, String, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import relationship, backref, mapped_column

from app.database import Base


class Chat(Base):
    __tablename__ = 'chat'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)
    scene_id = mapped_column(String(128), nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    updated_at = mapped_column(
        DateTime,
        nullable=False,
        default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    messages = relationship('ChatMessage', backref=backref('chat', lazy=True), cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'frame_id': self.frame_id,
            'scene_id': self.scene_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class ChatMessage(Base):
    __tablename__ = 'chat_message'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    chat_id = mapped_column(String(36), ForeignKey('chat.id'), nullable=False)
    role = mapped_column(String(20), nullable=False)
    content = mapped_column(Text, nullable=False)
    tool = mapped_column(String(64), nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    def to_dict(self):
        return {
            'id': self.id,
            'chat_id': self.chat_id,
            'role': self.role,
            'content': self.content,
            'tool': self.tool,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
