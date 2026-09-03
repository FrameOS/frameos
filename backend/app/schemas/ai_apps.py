from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class AiAppChatMessage(BaseModel):
    # Only the two roles a client may replay; anything else (system, tool)
    # would let a request smuggle instructions into the model context.
    role: Literal["user", "assistant"]
    content: str


class AiAppChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    chat_id: Optional[str] = Field(default=None, alias="chatId")
    frame_id: Optional[int] = Field(default=None, alias="frameId")
    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    node_id: Optional[str] = Field(default=None, alias="nodeId")
    app_name: Optional[str] = Field(default=None, alias="appName")
    app_keyword: Optional[str] = Field(default=None, alias="appKeyword")
    sources: Optional[dict[str, str]] = None
    history: Optional[list[AiAppChatMessage]] = None
    request_id: Optional[str] = Field(default=None, alias="requestId")


class AiAppChatResponse(BaseModel):
    reply: str
    tool: str
    chat_id: Optional[str] = Field(default=None, alias="chatId")
    files: Optional[dict[str, str]] = None
