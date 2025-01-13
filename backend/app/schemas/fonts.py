from pydantic import BaseModel, Field
from typing import List, Optional


class FontMetadata(BaseModel):
    file: str = Field(..., description="Font .ttf filename")
    name: str = Field(..., description="Font family name")
    weight: Optional[int] = Field(None, description="Font weight")
    weight_title: str = Field(..., description="Font weight title")
    italic: Optional[bool] = Field(None, description="Font is italic")

class FontsListResponse(BaseModel):
    fonts: List[FontMetadata]
