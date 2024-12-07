from typing import Optional, List, Any
from pydantic import BaseModel

class TemplateBase(BaseModel):
    name: Optional[str]
    description: Optional[str]
    scenes: Optional[List[Any]]
    config: Optional[Any]

class TemplateCreate(TemplateBase):
    url: Optional[str]
    from_frame_id: Optional[str]
    format: Optional[str]

class TemplateUpdate(BaseModel):
    name: Optional[str]
    description: Optional[str]
