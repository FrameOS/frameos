from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class GalleryBase(BaseModel):
    name: str = Field(..., max_length=255)
    description: Optional[str] = None


class GalleryCreateRequest(GalleryBase):
    pass


class GalleryUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class GalleryResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    image_count: int
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


class GalleryListResponse(BaseModel):
    galleries: list[GalleryResponse]


class GalleryImageResponse(BaseModel):
    id: str
    gallery_id: int
    filename: str
    mime_type: Optional[str]
    extension: Optional[str]
    width: Optional[int]
    height: Optional[int]
    file_size: Optional[int]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    thumbnail_url: Optional[str] = None
    original_url: str


class GalleryImagesListResponse(BaseModel):
    images: list[GalleryImageResponse]
