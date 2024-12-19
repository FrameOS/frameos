from pydantic import BaseModel, RootModel
from typing import Any, List, Optional
from datetime import datetime

class RepositoryBase(BaseModel):
    id: str
    name: str
    description: Optional[str]
    url: Optional[str]
    last_updated_at: Optional[datetime]
    templates: Optional[List[Any]]

    class Config:
        orm_mode = True

class RepositoryCreateRequest(BaseModel):
    url: str

class RepositoriesListResponse(RootModel):
    pass

class RepositoryResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    url: Optional[str]
    last_updated_at: Optional[datetime]
    templates: Optional[List[Any]]

    class Config:
        orm_mode = False  # since we are using to_dict, not orm_mode
