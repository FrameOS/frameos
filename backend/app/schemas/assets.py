from pydantic import BaseModel

class AssetResponse(BaseModel):
    """
    Minimal schema for returning the basic Asset info.
    """
    id: str
    path: str
    size: int
