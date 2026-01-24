from datetime import datetime
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict, Field


class ChatCreateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    frame_id: int = Field(alias="frameId")
    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    context_type: Optional[str] = Field(default=None, alias="contextType")
    context_id: Optional[str] = Field(default=None, alias="contextId")


class ChatSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    frame_id: int = Field(alias="frameId")
    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    context_type: Optional[str] = Field(default=None, alias="contextType")
    context_id: Optional[str] = Field(default=None, alias="contextId")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class ChatMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    role: Literal["user", "assistant"]
    content: str
    tool: Optional[str] = None
    created_at: datetime = Field(alias="createdAt")


class ChatListResponse(BaseModel):
    chats: list[ChatSummary]
    has_more: bool = Field(alias="hasMore")
    next_offset: Optional[int] = Field(default=None, alias="nextOffset")


class ChatDetailResponse(BaseModel):
    chat: ChatSummary
    messages: list[ChatMessageResponse]
