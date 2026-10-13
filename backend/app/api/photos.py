"""Photos: the library of albums frames play. `docs/photos.md` is the
contract; the disk side is app/utils/photos.py.

Owner routes are project scoped (`/api/projects/{id}/photos/...`). The share
routes (`/api/photos/shared/{token}...`) are what frames call: no login, the
token is the credential and resolves the project, and they live on the public
router (the one Home Assistant exposes on port 8989), rate limited per
address and link.
"""
from __future__ import annotations

import asyncio
import secrets
from http import HTTPStatus
from pathlib import Path

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.photo_share import PhotoShare
from app.redis import get_redis
from app.tenancy import current_project_id
from app.utils import photos
from app.utils.asset_headers import inert_asset_headers
from app.utils.rate_limit import hit_rate_limit
from app.utils.request_ip import client_ip_for_request
from app.utils.upload_limits import read_body_limited
from . import api_project, api_public

# Registered on the routers by import; nothing to re-export into app.api.
__all__: list[str] = []

# Frames render every few minutes and several of them may share one address
# (and one album): generous, per address and link.
SHARE_REQUESTS_PER_HOUR = 1200
SHARE_RATE_WINDOW_SECONDS = 3600
MAX_PATHS_PER_REQUEST = 10000


class PhotoPathBody(BaseModel):
    path: str


class PhotoMoveBody(BaseModel):
    paths: list[str] = Field(max_length=MAX_PATHS_PER_REQUEST)
    to: str = ""


class PhotoRenameBody(BaseModel):
    path: str
    name: str


class PhotoDeleteBody(BaseModel):
    paths: list[str] = Field(max_length=MAX_PATHS_PER_REQUEST)


async def _ready_root(project_id: int) -> Path:
    return await asyncio.to_thread(photos.ready_root, project_id)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=detail)


def _not_found(detail: str = "Not found") -> HTTPException:
    return HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=detail)


# ---------------------------------------------------------------------------
# Owner routes
# ---------------------------------------------------------------------------


@api_project.get("/photos/status")
async def photos_status():
    return await asyncio.to_thread(photos.status, current_project_id())


@api_project.get("/photos/files")
async def photos_files(path: str = ""):
    rel = photos.validate_path(path, allow_root=True)
    root = await _ready_root(current_project_id())
    return await asyncio.to_thread(photos.list_folder, root, rel)


@api_project.post("/photos/upload")
async def photos_upload(request: Request, db: Session = Depends(get_db)):
    """One chunk of one file (raw body), the frame asset routes' protocol:
    `?path=<folder>&filename=<name>&upload_id=<id>&offset=<n>&complete=0|1`."""
    params = request.query_params
    upload_id = params.get("upload_id") or ""
    if not photos.valid_upload_id(upload_id):
        raise _bad_request("upload_id must be 8 to 64 letters, digits, - or _")
    folder = photos.validate_path(params.get("path") or "", allow_root=True)
    filename = photos.validate_name(params.get("filename"))
    photos.validate_path(photos.join_path(folder, filename))
    try:
        offset = int(params.get("offset") or "0")
    except ValueError:
        raise _bad_request("offset must be a number")
    if offset < 0:
        raise _bad_request("offset must be a number")
    complete = (params.get("complete") or "1").lower() in ("1", "true")
    if offset > photos.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="Uploaded file too large")

    project_id = current_project_id()
    root = await _ready_root(project_id)
    chunk = await read_body_limited(request, photos.MAX_CHUNK_BYTES, "Chunks can be at most 4 MiB")
    if not chunk and not complete:
        raise _bad_request("Empty chunk")
    received = await asyncio.to_thread(photos.write_chunk, project_id, upload_id, offset, chunk)
    if not complete:
        return {"pending": True, "received": received}
    entry = await asyncio.to_thread(photos.finish_upload, db, project_id, root, folder, filename, upload_id)
    return {"entry": entry}


@api_project.get("/photos/thumb")
async def photos_thumb(request: Request, path: str = ""):
    rel = photos.validate_path(path)
    project_id = current_project_id()
    root = await _ready_root(project_id)
    made = await asyncio.to_thread(photos.thumbnail, project_id, root, rel)
    if made is None:
        raise _not_found("No thumbnail")
    thumb, key = made
    etag = f'"{key}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if etag in (request.headers.get("if-none-match") or ""):
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers=headers)
    return FileResponse(thumb, media_type="image/jpeg", headers=headers)


@api_project.post("/photos/thumb", status_code=HTTPStatus.NO_CONTENT)
async def photos_thumb_upload(path: str = ""):
    """The cloud stores thumbnails the browser makes; the backend makes its
    own (`client_thumbnails: false`) and ignores these."""
    photos.validate_path(path)
    await _ready_root(current_project_id())
    return Response(status_code=HTTPStatus.NO_CONTENT)


@api_project.get("/photos/file")
async def photos_file(path: str = "", download: str = ""):
    rel = photos.validate_path(path)
    root = await _ready_root(current_project_id())
    target = await asyncio.to_thread(photos.existing_file, root, rel)
    name = photos.base_name(rel)
    content_type = photos.content_type_for(name)
    inline = download.lower() not in ("1", "true") and content_type.startswith("image/")
    headers = inert_asset_headers(content_type, name, inline=inline)
    headers["Cache-Control"] = "private, no-cache"
    return FileResponse(target, media_type=content_type, headers=headers)


@api_project.post("/photos/folders")
async def photos_create_folder(data: PhotoPathBody, db: Session = Depends(get_db)):
    rel = photos.validate_path(data.path)
    project_id = current_project_id()
    root = await _ready_root(project_id)
    entry = await asyncio.to_thread(photos.create_folder, db, project_id, root, rel)
    return {"entry": entry}


@api_project.post("/photos/move")
async def photos_move(data: PhotoMoveBody, db: Session = Depends(get_db)):
    to = photos.validate_path(data.to, allow_root=True)
    paths = [photos.validate_path(path) for path in data.paths]
    project_id = current_project_id()
    root = await _ready_root(project_id)
    moved = await asyncio.to_thread(photos.move_paths, db, project_id, root, paths, to)
    return {"moved": moved}


@api_project.post("/photos/rename")
async def photos_rename(data: PhotoRenameBody, db: Session = Depends(get_db)):
    rel = photos.validate_path(data.path)
    name = photos.validate_name(data.name)
    project_id = current_project_id()
    root = await _ready_root(project_id)
    entry = await asyncio.to_thread(photos.rename_path, db, project_id, root, rel, name)
    return {"entry": entry}


@api_project.post("/photos/delete")
async def photos_delete(data: PhotoDeleteBody, db: Session = Depends(get_db)):
    paths = [photos.validate_path(path) for path in data.paths]
    project_id = current_project_id()
    root = await _ready_root(project_id)
    deleted = await asyncio.to_thread(photos.delete_paths, db, project_id, root, paths)
    return {"deleted": deleted}


@api_project.get("/photos/shares")
async def photos_shares(db: Session = Depends(get_db)):
    await _ready_root(current_project_id())
    shares = (
        db.query(PhotoShare)
        .filter(PhotoShare.project_id == current_project_id())
        .order_by(PhotoShare.path.asc(), PhotoShare.id.asc())
        .all()
    )
    return {"shares": [photos.share_json(share) for share in shares]}


@api_project.post("/photos/shares")
async def photos_create_share(data: PhotoPathBody, db: Session = Depends(get_db)):
    if data.path == "":
        raise _bad_request("Share a folder, not the whole library")
    rel = photos.validate_path(data.path)
    project_id = current_project_id()
    root = await _ready_root(project_id)
    folder = photos.disk_path(root, rel)
    if not await asyncio.to_thread(folder.is_dir):
        raise _not_found("Folder not found")
    share = (
        db.query(PhotoShare)
        .filter(PhotoShare.project_id == project_id, PhotoShare.path == rel)
        .order_by(PhotoShare.id.asc())
        .first()
    )
    if share is None:
        share = PhotoShare(project_id=project_id, path=rel, token=f"pk_{secrets.token_urlsafe(32)}")
        db.add(share)
        db.commit()
        db.refresh(share)
    return {"share": photos.share_json(share)}


@api_project.delete("/photos/shares/{token}")
async def photos_delete_share(token: str, db: Session = Depends(get_db)):
    await _ready_root(current_project_id())
    share = (
        db.query(PhotoShare)
        .filter(PhotoShare.project_id == current_project_id(), PhotoShare.token == token)
        .first()
    )
    if share is None:
        raise _not_found("Share link not found")
    db.delete(share)
    db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Share routes (frames)
# ---------------------------------------------------------------------------


async def _shared_folder(request: Request, token: str, db: Session, redis: Redis) -> photos.SharedFolder:
    if not photos.valid_share_token(token):
        raise _not_found()
    address = client_ip_for_request(request) or "unknown"
    if await hit_rate_limit(
        redis,
        "photo_share",
        f"{address}:{token}",
        limit=SHARE_REQUESTS_PER_HOUR,
        window_seconds=SHARE_RATE_WINDOW_SECONDS,
    ):
        raise HTTPException(status_code=HTTPStatus.TOO_MANY_REQUESTS, detail="Too many requests")
    share = db.query(PhotoShare).filter(PhotoShare.token == token).first()
    if share is None:
        raise _not_found()
    return await asyncio.to_thread(photos.shared_folder, share)


@api_public.get("/photos/shared/{token}")
async def photos_shared_listing(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    shared = await _shared_folder(request, token, db, redis)

    def build() -> dict:
        files, updated_at = photos.share_index(shared)
        return {
            "name": shared.name,
            "count": len(files),
            "updated_at": updated_at,
            "files": [photos.shared_photo_json(token, photo) for photo in files],
        }

    return await asyncio.to_thread(build)


@api_public.get("/photos/shared/{token}/photo")
async def photos_shared_photo(
    token: str,
    request: Request,
    order: str = "random",
    index: int = Query(0),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if order not in photos.SHARE_ORDERS:
        raise _bad_request(f"order must be one of {', '.join(photos.SHARE_ORDERS)}")
    shared = await _shared_folder(request, token, db, redis)

    def build() -> dict:
        files, _updated_at = photos.share_index(shared)
        photo = photos.pick_photo(files, order, index, token)
        return {
            "index": index,
            "count": len(files),
            "photo": photos.shared_photo_json(token, photo) if photo is not None else None,
        }

    return await asyncio.to_thread(build)


@api_public.get("/photos/shared/{token}/file")
async def photos_shared_file(
    token: str,
    request: Request,
    path: str = "",
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    shared = await _shared_folder(request, token, db, redis)
    rel = photos.validate_path(path)
    target = await asyncio.to_thread(photos.shared_file, shared, rel)
    name = photos.base_name(rel)
    content_type = photos.content_type_for(name)
    headers = inert_asset_headers(content_type, name, inline=True)
    headers["Cache-Control"] = "public, max-age=300"
    return FileResponse(target, media_type=content_type, headers=headers)
