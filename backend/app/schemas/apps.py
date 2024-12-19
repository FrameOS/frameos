from pydantic import BaseModel,RootModel
from typing import Dict, List, Optional

class AppConfigSchema(BaseModel):
    name: str
    # add other fields from config.json if necessary

class AppsListResponse(BaseModel):
    apps: Dict[str, AppConfigSchema]

class AppsSourceResponse(RootModel):
    pass  # filename -> source code mapping

class ValidateSourceRequest(BaseModel):
    file: str
    source: str

class ValidateError(BaseModel):
    line: int
    column: int
    error: str

class ValidateSourceResponse(BaseModel):
    errors: List[ValidateError]

class EnhanceSourceRequest(BaseModel):
    source: str
    prompt: str

class EnhanceSourceResponse(BaseModel):
    suggestion: Optional[str] = None
    error: Optional[str] = None
