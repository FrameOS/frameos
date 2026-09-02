import uuid
import re
from typing import Optional
from http import HTTPStatus
from fastapi import Depends, HTTPException, File, Form, Request, UploadFile, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from fastapi.responses import Response

from app.database import get_db
from app.models.assets import Assets
from app.api.project_scope import project_get_or_404, project_query
from app.schemas.assets import (
    AssetResponse
)
from app.tenancy import current_project_id
from app.utils.upload_limits import MAX_ASSET_UPLOAD_BYTES, read_upload_limited, reject_oversized_content_length
from . import api_project

# This file handles assets uploaded under /settings. For assets on frames, see frame.py.


# Asset paths are relative names under the project's asset tree ("fonts/x.ttf").
# They are later joined onto local build folders and onto the frame's asset
# directory, so a path with ".." segments or a leading "/" would write outside
# both. Any printable name is fine; only the separators and dot segments matter.
def _validated_asset_path(path: str) -> str:
    value = (path or "").strip().replace("\\", "/")
    segments = value.split("/")
    if (
        not value
        or len(value) > 512
        or any(
            seg == "" or seg in (".", "..") or any(ord(ch) < 0x20 or ch == "\x7f" for ch in seg)
            for seg in segments
        )
    ):
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Asset path must be a relative path of plain file and folder names",
        )
    return value

@api_project.get("/assets", response_model=list[AssetResponse])
async def list_assets(
    path: Optional[str] = Query(None, description="Optional substring filter on the asset path"),
    db: Session = Depends(get_db)
):
    """
    Return a list of all stored Assets (without the binary data).
    Optionally filter by `path` if specified.
    """
    query = project_query(db, Assets)
    if path:
        query = query.filter(Assets.path.ilike(f"%{path}%"))
    results = query.all()

    output = []
    for asset in results:
        output.append(AssetResponse(
            id=asset.id,
            path=asset.path,
            size=len(asset.data) if asset.data else 0
        ))
    return output


@api_project.get("/assets/{asset_id}", response_model=AssetResponse)
async def get_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Return metadata for a single asset by its ID.
    """
    asset = project_get_or_404(db, Assets, asset_id, detail="Asset not found")

    return AssetResponse(
        id=asset.id,
        path=asset.path,
        size=len(asset.data) if asset.data else 0
    )


@api_project.get("/assets/{asset_id}/download")
async def download_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Download the raw binary data of an asset by ID.
    """
    asset = project_get_or_404(db, Assets, asset_id, detail="Asset not found")
    if not asset.data:
        raise HTTPException(status_code=404, detail="Asset has no data")

    return Response(
        content=asset.data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{uuid.uuid4()}"'}
    )


@api_project.post("/assets", response_model=AssetResponse, status_code=201)
async def create_asset(
    request: Request,
    path: str = Form(..., description="Unique path identifier for this asset"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """
    Create and store a new asset in the DB, reading from multipart/form-data.
      - `path` must be unique
      - `file` is the actual file data
    """
    reject_oversized_content_length(request, MAX_ASSET_UPLOAD_BYTES)
    project_id = current_project_id()
    path = _validated_asset_path(path)
    existing = db.query(Assets).filter_by(project_id=project_id, path=path).first()
    if existing:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail=f"Asset path '{path}' is already in use."
        )

    try:
        content = await read_upload_limited(file, MAX_ASSET_UPLOAD_BYTES)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Error reading uploaded file.")

    new_asset = Assets(project_id=project_id, path=path, data=content)
    db.add(new_asset)
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")

    return AssetResponse(
        id=new_asset.id,
        path=new_asset.path,
        size=len(new_asset.data) if new_asset.data else 0
    )


@api_project.put("/assets/{asset_id}", response_model=AssetResponse)
async def update_asset(
    request: Request,
    asset_id: str,
    path: Optional[str] = Form(None, description="New path (must remain unique)"),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    """
    Update an existing asset with multipart/form-data.
    You can update:
      - The path (unique)
      - The file contents (if provided).
    If you only want to change the path (and not the file), omit `file`.
    """
    reject_oversized_content_length(request, MAX_ASSET_UPLOAD_BYTES)
    project_id = current_project_id()
    asset = project_get_or_404(db, Assets, asset_id, detail="Asset not found")

    # If user wants to update the path:
    if path:
        path = _validated_asset_path(path)
    if path and path != asset.path:
        # check uniqueness of new path
        conflict = db.query(Assets).filter_by(project_id=project_id, path=path).first()
        if conflict and conflict.id != asset_id:
            raise HTTPException(
                status_code=HTTPStatus.BAD_REQUEST,
                detail=f"Another asset already uses path '{path}'."
            )
        asset.path = path

    # If user wants to update the binary data:
    if file is not None:
        try:
            content = await read_upload_limited(file, MAX_ASSET_UPLOAD_BYTES)
            asset.data = content
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=400, detail="Error reading uploaded file.")

    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")

    return AssetResponse(
        id=asset.id,
        path=asset.path,
        size=len(asset.data) if asset.data else 0
    )


@api_project.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Delete an asset by ID.
    """
    asset = project_get_or_404(db, Assets, asset_id, detail="Asset not found")

    db.delete(asset)
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")

    return {"message": "Asset deleted successfully"}
