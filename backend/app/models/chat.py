from uuid import NAMESPACE_URL, uuid4, uuid5
from sqlalchemy import Integer, String, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import Session, relationship, backref, mapped_column

from app.database import Base


class Chat(Base):
    __tablename__ = 'chat'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)
    scene_id = mapped_column(String(128), nullable=True)
    context_type = mapped_column(String(32), nullable=True)
    context_id = mapped_column(String(256), nullable=True)
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
            'project_id': self.project_id,
            'frame_id': self.frame_id,
            'scene_id': self.scene_id,
            'context_type': self.context_type,
            'context_id': self.context_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class ChatMessage(Base):
    __tablename__ = 'chat_message'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    chat_id = mapped_column(String(36), ForeignKey('chat.id'), nullable=False)
    role = mapped_column(String(20), nullable=False)
    content = mapped_column(Text, nullable=False)
    tool = mapped_column(String(64), nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    def to_dict(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'chat_id': self.chat_id,
            'role': self.role,
            'content': self.content,
            'tool': self.tool,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


# A chat id a caller proposes (the SPA names a new chat with a uuid of its own
# before the first message is sent) is never stored as it is: the primary key
# is global, so inserting it answered — by colliding or not — whether that id
# already existed in some other project. A new chat is stored under an id
# derived from (project, proposed id) instead: the same proposal lands in the
# same chat on every request, and nothing about other projects shows.
_CHAT_ID_NAMESPACE = uuid5(NAMESPACE_URL, "https://frameos.net/backend/ai-chat")


def project_chat_id(project_id: int, proposed_id: str) -> str:
    return str(uuid5(_CHAT_ID_NAMESPACE, f"{project_id}:{proposed_id}"))


def find_project_chat(db: Session, project_id: int, chat_id: str | None) -> "Chat | None":
    """This project's chat for an id a caller sent: one stored under that id
    (ids this backend minted or derived, and chats from before derived ids)
    or under the id derived from it."""
    if not chat_id:
        return None
    candidates = {chat_id, project_chat_id(project_id, chat_id)}
    return db.query(Chat).filter(Chat.project_id == project_id, Chat.id.in_(candidates)).first()
