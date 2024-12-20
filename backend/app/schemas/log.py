from pydantic import BaseModel
from typing import Any, List, Optional

class SingleLogEntry(BaseModel):
    event: Optional[str] = None
    # add other fields as needed
    # __root__: Dict[str, Any]

class LogRequest(BaseModel):
    log: Optional[Any] = None
    logs: Optional[List[Any]] = None

class LogResponse(BaseModel):
    message: str = "OK"
