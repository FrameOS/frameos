from typing import Any, Optional, Literal

from pydantic import BaseModel, ConfigDict, Field


class AiSceneGenerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    frame_id: Optional[int] = Field(default=None, alias="frameId")
    request_id: Optional[str] = Field(default=None, alias="requestId")


class AiSceneContextItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_type: str
    source_path: str
    name: Optional[str]
    summary: str
    metadata: Optional[dict[str, Any]] = None


class AiSceneGenerateResponse(BaseModel):
    title: Optional[str] = None
    scenes: list[dict[str, Any]]
    context: list[AiSceneContextItem]


class AiSceneChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AiSceneAppContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    node_id: Optional[str] = Field(default=None, alias="nodeId")
    name: Optional[str] = None
    keyword: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    sources: Optional[dict[str, str]] = None


class AiSceneChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    chat_id: Optional[str] = Field(default=None, alias="chatId")
    frame_id: Optional[int] = Field(default=None, alias="frameId")
    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    scene: Optional[dict[str, Any]] = None
    selected_nodes: Optional[list[dict[str, Any]]] = Field(default=None, alias="selectedNodes")
    selected_edges: Optional[list[dict[str, Any]]] = Field(default=None, alias="selectedEdges")
    app: Optional[AiSceneAppContext] = None
    history: Optional[list[AiSceneChatMessage]] = None
    request_id: Optional[str] = Field(default=None, alias="requestId")


class AiSceneChatResponse(BaseModel):
    reply: str
    tool: str
    chat_id: Optional[str] = Field(default=None, alias="chatId")
    title: Optional[str] = None
    scenes: Optional[list[dict[str, Any]]] = None
    app_sources: Optional[dict[str, str]] = Field(default=None, alias="appSources")
