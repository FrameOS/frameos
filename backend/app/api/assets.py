import uuid
from typing import Optional
from http import HTTPStatus
from fastapi import Depends, HTTPException, File, Form, UploadFile, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from fastapi.responses import Response

from app.database import get_db
from app.models.assets import Assets
from app.schemas.assets import (
    AssetResponse
)
from . import api_with_auth

@api_with_auth.get("/assets", response_model=list[AssetResponse])
async def list_assets(
    path: Optional[str] = Query(None, description="Optional substring filter on the asset path"),
    db: Session = Depends(get_db)
):
    """
    Return a list of all stored Assets (without the binary data).
    Optionally filter by `path` if specified.
    """
    query = db.query(Assets)
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


@api_with_auth.get("/assets/{asset_id}", response_model=AssetResponse)
async def get_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Return metadata for a single asset by its ID.
    """
    asset = db.query(Assets).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    return AssetResponse(
        id=asset.id,
        path=asset.path,
        size=len(asset.data) if asset.data else 0
    )


@api_with_auth.get("/assets/{asset_id}/download")
async def download_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Download the raw binary data of an asset by ID.
    """
    asset = db.query(Assets).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if not asset.data:
        raise HTTPException(status_code=404, detail="Asset has no data")

    return Response(
        content=asset.data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{uuid.uuid4()}"'}
    )


@api_with_auth.post("/assets", response_model=AssetResponse, status_code=201)
async def create_asset(
    path: str = Form(..., description="Unique path identifier for this asset"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """
    Create and store a new asset in the DB, reading from multipart/form-data.
      - `path` must be unique
      - `file` is the actual file data
    """
    existing = db.query(Assets).filter_by(path=path).first()
    if existing:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail=f"Asset path '{path}' is already in use."
        )

    try:
        content = await file.read()
    except Exception:
        raise HTTPException(status_code=400, detail="Error reading uploaded file.")

    new_asset = Assets(path=path, data=content)
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


@api_with_auth.put("/assets/{asset_id}", response_model=AssetResponse)
async def update_asset(
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
    asset = db.query(Assets).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    # If user wants to update the path:
    if path and path != asset.path:
        # check uniqueness of new path
        conflict = db.query(Assets).filter_by(path=path).first()
        if conflict and conflict.id != asset_id:
            raise HTTPException(
                status_code=HTTPStatus.BAD_REQUEST,
                detail=f"Another asset already uses path '{path}'."
            )
        asset.path = path

    # If user wants to update the binary data:
    if file is not None:
        try:
            content = await file.read()
            asset.data = content
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


@api_with_auth.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str, db: Session = Depends(get_db)):
    """
    Delete an asset by ID.
    """
    asset = db.query(Assets).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    db.delete(asset)
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")

    return {"message": "Asset deleted successfully"}
