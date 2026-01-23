from http import HTTPStatus

from fastapi import Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api import api_with_auth
from app.database import get_db
from app.models.chat import Chat, ChatMessage
from app.schemas.chats import ChatCreateRequest, ChatDetailResponse, ChatListResponse, ChatSummary


@api_with_auth.post("/ai/chats", response_model=ChatSummary)
async def create_chat(data: ChatCreateRequest, db: Session = Depends(get_db)):
    chat = Chat(frame_id=data.frame_id, scene_id=data.scene_id)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


@api_with_auth.get("/ai/chats", response_model=ChatListResponse)
async def list_chats(
    frame_id: int = Query(..., alias="frameId"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    base_query = db.query(Chat).filter(Chat.frame_id == frame_id, Chat.messages.any())
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


@api_with_auth.get("/ai/chats/{chat_id}", response_model=ChatDetailResponse)
async def get_chat(chat_id: str, db: Session = Depends(get_db)):
    chat = db.query(Chat).filter(Chat.id == chat_id).first()
    if not chat:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Chat not found")
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.chat_id == chat_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return ChatDetailResponse(chat=chat, messages=messages)
