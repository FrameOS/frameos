from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class AiSceneGenerateRequest(BaseModel):
    prompt: str


class AiSceneContextItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_type: str
    source_path: str
    name: Optional[str]
    summary: str
    metadata: Optional[dict[str, Any]] = None


class AiSceneGenerateResponse(BaseModel):
    scenes: list[dict[str, Any]]
    context: list[AiSceneContextItem]
