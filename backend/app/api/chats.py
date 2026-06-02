from fastapi import Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.api.project_scope import project_get_or_404, project_query
from app.models.frame import Frame
from app.models.chat import Chat, ChatMessage
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
    frame_id: int = Query(..., alias="frameId"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    project_get_or_404(db, Frame, frame_id, detail="Frame not found")
    base_query = project_query(db, Chat).filter(Chat.frame_id == frame_id, Chat.messages.any())
    total = base_query.count()
    chats = (
        base_query.order_by(Chat.updated_at.desc(), Chat.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    next_offset = offset + len(chats)
    has_more = next_offset < total
    return ChatListResponse(chats=chats, hasMore=has_more, nextOffset=next_offset if has_more else None)


@api_project.get("/ai/chats/{chat_id}", response_model=ChatDetailResponse)
async def get_chat(chat_id: str, db: Session = Depends(get_db)):
    chat = project_get_or_404(db, Chat, chat_id, detail="Chat not found")
    messages = (
        project_query(db, ChatMessage)
        .filter(ChatMessage.chat_id == chat_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return ChatDetailResponse(chat=chat, messages=messages)
