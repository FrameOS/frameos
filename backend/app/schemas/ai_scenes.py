from typing import Any, Optional

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
