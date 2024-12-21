from pydantic import BaseModel, ConfigDict, RootModel
from typing import Any, List, Optional
from datetime import datetime

class RepositoryBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: Optional[str]
    url: Optional[str]
    last_updated_at: Optional[datetime]
    templates: Optional[List[Any]]

class RepositoryCreateRequest(BaseModel):
    url: str

class RepositoryUpdateRequest(RepositoryCreateRequest):
    url: str | None = None
    name: str | None = None

class RepositoriesListResponse(RootModel):
    pass

class RepositoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=False)

    id: str
    name: str
    description: Optional[str]
    url: Optional[str]
    last_updated_at: Optional[datetime]
    templates: Optional[List[Any]]
