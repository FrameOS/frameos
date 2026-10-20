from http import HTTPStatus

from fastapi import Depends, HTTPException, Query
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.api.project_scope import project_get_or_404, project_query
from app.models.frame import Frame
from app.models.chat import Chat, ChatMessage, derive_chat_title, find_project_chat
from app.schemas.chats import ChatCreateRequest, ChatDetailResponse, ChatListResponse, ChatSummary
from app.tenancy import current_project_id
from . import api_project


@api_project.post("/ai/chats", response_model=ChatSummary)
async def create_chat(data: ChatCreateRequest, db: Session = Depends(get_db)):
    project_id = current_project_id()
    project_get_or_404(db, Frame, data.frame_id, detail="Frame not found")

    context_type = data.context_type
    context_id = data.context_id
    if not context_type:
        context_type = "scene" if data.scene_id else "frame"
    if context_type == "scene" and not context_id:
        context_id = data.scene_id
    chat = Chat(
        project_id=project_id,
        frame_id=data.frame_id,
        scene_id=data.scene_id,
        context_type=context_type,
        context_id=context_id,
    )
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


@api_project.get("/ai/chats", response_model=ChatListResponse)
async def list_chats(
    frame_id: int | None = Query(None, alias="frameId"),
    frameless: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    # Without a frame: every chat of the project; `frameless` keeps the ones
    # about no frame, which the frames home's AI drawer lists (docs/ai-chat.md).
    base_query = project_query(db, Chat).filter(Chat.messages.any())
    if frameless:
        base_query = base_query.filter(Chat.frame_id.is_(None))
    if frame_id is not None:
        project_get_or_404(db, Frame, frame_id, detail="Frame not found")
        base_query = base_query.filter(Chat.frame_id == frame_id)
    total = base_query.count()
    chats = (
        base_query.order_by(Chat.updated_at.desc(), Chat.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    next_offset = offset + len(chats)
    has_more = next_offset < total
    return ChatListResponse(
        chats=_summaries_with_titles(db, chats),
        hasMore=has_more,
        nextOffset=next_offset if has_more else None,
    )


def _summaries_with_titles(db: Session, chats: list[Chat]) -> list[ChatSummary]:
    """The page's chats with what the history shows of them: the first user
    message as the title and how many messages there are."""
    ids = [chat.id for chat in chats]
    if not ids:
        return []
    counts = dict(
        db.query(ChatMessage.chat_id, func.count(ChatMessage.id))
        .filter(ChatMessage.chat_id.in_(ids))
        .group_by(ChatMessage.chat_id)
        .all()
    )
    first_asked = (
        db.query(ChatMessage.chat_id, func.min(ChatMessage.created_at).label("at"))
        .filter(ChatMessage.chat_id.in_(ids), ChatMessage.role == "user")
        .group_by(ChatMessage.chat_id)
        .subquery()
    )
    titles: dict[str, str | None] = {}
    for chat_id, content in (
        db.query(ChatMessage.chat_id, ChatMessage.content)
        .join(first_asked, and_(ChatMessage.chat_id == first_asked.c.chat_id, ChatMessage.created_at == first_asked.c.at))
        .filter(ChatMessage.role == "user")
        .all()
    ):
        titles.setdefault(chat_id, derive_chat_title(content))
    return [
        ChatSummary.model_validate(chat).model_copy(
            update={"title": titles.get(chat.id), "message_count": counts.get(chat.id, 0)}
        )
        for chat in chats
    ]


@api_project.get("/ai/chats/{chat_id}", response_model=ChatDetailResponse)
async def get_chat(chat_id: str, db: Session = Depends(get_db)):
    # The id the browser named a new chat with resolves to the stored one
    # (app/models/chat.py project_chat_id).
    chat = find_project_chat(db, current_project_id(), chat_id)
    if chat is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Chat not found")
    messages = (
        project_query(db, ChatMessage)
        .filter(ChatMessage.chat_id == chat.id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return ChatDetailResponse(chat=chat, messages=messages)
