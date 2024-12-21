from pydantic import BaseModel, ConfigDict, RootModel
from typing import Any, List, Optional

class TemplateBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: Optional[str]
    name: str
    description: Optional[str]
    scenes: Optional[List[Any]]
    image: Optional[str] = None
    imageWidth: Optional[int] = None
    imageHeight: Optional[int] = None

class TemplateResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    scenes: Optional[List[Any]]
    image: Optional[str]
    imageWidth: Optional[int]
    imageHeight: Optional[int]

class TemplatesListResponse(RootModel[List[TemplateResponse]]):
    pass

class CreateTemplateRequest(BaseModel):
    from_frame_id: Optional[int] = None
    url: Optional[str] = None
    format: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    scenes: Optional[List[Any]] = None
    config: Optional[Any] = None
    image: Optional[str] = None
    imageWidth: Optional[int] = None
    imageHeight: Optional[int] = None

class UpdateTemplateRequest(BaseModel):
    name: Optional[str]
    description: Optional[str]
