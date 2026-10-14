"""Photos: the library of albums frames play. `docs/photos.md` is the
contract; the rows, the object store and everything blocking are in
app/utils/photos.py.

Owner routes are project scoped (`/api/projects/{id}/photos/...`). The share
routes (`/api/photos/shared/{token}...`) are what frames call: no login, the
token is the credential and resolves the project, and they live on the public
router (the one Home Assistant exposes on port 8989), rate limited per
address.
"""
from __future__ import annotations

import asyncio
import secrets
from http import HTTPStatus
from typing import Any

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame, server_scheme_for_frame
from app.models.photo_share import PhotoShare
from app.redis import get_redis
from app.tenancy import current_project_id
from app.utils import photos
from app.utils.asset_headers import inert_asset_headers
from app.utils.object_store import ObjectStore
from app.utils.photo_album_scene import DEFAULT_SECONDS, FIT_VALUES, ORDER_VALUES, build_photo_album_scene
from app.utils.rate_limit import hit_rate_limit
from app.utils.request_ip import client_ip_for_request
from app.utils.upload_limits import read_body_limited
from . import api_project, api_public

# Registered on the routers by import; nothing to re-export into app.api.
__all__: list[str] = []

# Per address, like the cloud. What the app asks for: two requests per render (the pick, then the file),
# every 5 s at the fastest, a few frames behind one address.
SHARE_REQUESTS_PER_HOUR = 3600
SHARE_RATE_WINDOW_SECONDS = 3600
MAX_PATHS_PER_REQUEST = 10000


class PhotoPathBody(BaseModel):
    path: str


class PhotoShareBody(BaseModel):
    path: str
    # A frame's own link to the folder; absent for the folder's general link.
    frame_id: Any = None
    # A custom link, named by the owner ("Grandma"): a new one every time.
    name: Any = None


MAX_SHARE_NAME_LENGTH = 120


class PhotoMoveBody(BaseModel):
    paths: list[str] = Field(max_length=MAX_PATHS_PER_REQUEST)
    to: str = ""


class PhotoRenameBody(BaseModel):
    path: str
    name: str


class PhotoDeleteBody(BaseModel):
    paths: list[str] = Field(max_length=MAX_PATHS_PER_REQUEST)


_NO_COLORS = object()


class PhotoColorsBody(BaseModel):
    path: str
    # Any JSON: the shape is checked by hand, so a wrong one (or a missing
    # key) is the contract's 400 rather than FastAPI's 422.
    colors: Any = _NO_COLORS


class PhotoSceneBody(BaseModel):
    path: str
    # Checked by hand too, for the contract's 400s.
    frame_id: Any = None
    name: Any = None
    seconds: Any = None
    order: Any = None
    fit: Any = None


MAX_SCENE_NAME_LENGTH = 256


async def _ready_store() -> ObjectStore:
    return await asyncio.to_thread(photos.ready_store)


def _some_paths(paths: list[str]) -> list[str]:
    if not paths:
        raise _bad_request("paths must not be empty")
    return [photos.validate_path(path) for path in paths]


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=detail)


def _not_found(detail: str = "Not found") -> HTTPException:
    return HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=detail)


def _bytes_response(stored: photos.StoredBytes, media_type: str, headers: dict[str, str]) -> Response:
    """The disk store's file is streamed; a bucket's bytes are sent as is."""
    if stored.path is not None:
        return FileResponse(stored.path, media_type=media_type, headers=headers)
    return Response(content=stored.data or b"", media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# Owner routes
# ---------------------------------------------------------------------------


@api_project.get("/photos/status")
async def photos_status(db: Session = Depends(get_db)):
    return await asyncio.to_thread(photos.status, db, current_project_id())


@api_project.get("/photos/files")
async def photos_files(path: str = "", db: Session = Depends(get_db)):
    rel = photos.validate_path(path, allow_root=True)
    await _ready_store()
    return await asyncio.to_thread(photos.list_folder, db, current_project_id(), rel)


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
    store = await _ready_store()
    chunk = await read_body_limited(request, photos.MAX_CHUNK_BYTES, "Chunks can be at most 4 MiB")
    if not chunk and not complete:
        raise _bad_request("Empty chunk")
    received = await asyncio.to_thread(photos.write_chunk, project_id, upload_id, offset, chunk)
    if not complete:
        return {"pending": True, "received": received}
    entry = await asyncio.to_thread(photos.finish_upload, db, project_id, store, folder, filename, upload_id)
    return {"entry": entry}


@api_project.get("/photos/thumb")
async def photos_thumb(request: Request, path: str = "", db: Session = Depends(get_db)):
    rel = photos.validate_path(path)
    store = await _ready_store()
    row = await asyncio.to_thread(photos.file_row, db, current_project_id(), rel)
    if not row.thumb_object_key:
        raise _not_found("No thumbnail")
    # The key is the thumbnail's content hash: a replaced file gets a new one.
    etag = f'"{row.thumb_object_key.rsplit("/", 1)[-1]}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if etag in (request.headers.get("if-none-match") or ""):
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers=headers)
    stored = await asyncio.to_thread(photos.fetch_object, store, row.thumb_object_key)
    return _bytes_response(stored, "image/jpeg", headers)


@api_project.get("/photos/file")
async def photos_file(path: str = "", download: str = "", db: Session = Depends(get_db)):
    rel = photos.validate_path(path)
    store = await _ready_store()
    row = await asyncio.to_thread(photos.file_row, db, current_project_id(), rel)
    name = photos.base_name(rel)
    content_type = row.content_type or photos.content_type_for(name)
    inline = download.lower() not in ("1", "true") and content_type.startswith("image/")
    headers = inert_asset_headers(content_type, name, inline=inline)
    headers["Cache-Control"] = "private, no-cache"
    stored = await asyncio.to_thread(photos.fetch_object, store, row.object_key)
    return _bytes_response(stored, content_type, headers)


@api_project.post("/photos/folders")
async def photos_create_folder(data: PhotoPathBody, db: Session = Depends(get_db)):
    rel = photos.validate_path(data.path)
    await _ready_store()
    entry = await asyncio.to_thread(photos.create_folder, db, current_project_id(), rel)
    return {"entry": entry}


@api_project.post("/photos/move")
async def photos_move(data: PhotoMoveBody, db: Session = Depends(get_db)):
    to = photos.validate_path(data.to, allow_root=True)
    paths = _some_paths(data.paths)
    await _ready_store()
    moved = await asyncio.to_thread(photos.move_paths, db, current_project_id(), paths, to)
    return {"moved": moved}


@api_project.post("/photos/rename")
async def photos_rename(data: PhotoRenameBody, db: Session = Depends(get_db)):
    rel = photos.validate_path(data.path)
    name = photos.validate_name(data.name)
    await _ready_store()
    entry = await asyncio.to_thread(photos.rename_path, db, current_project_id(), rel, name)
    return {"entry": entry}


@api_project.post("/photos/delete")
async def photos_delete(data: PhotoDeleteBody, db: Session = Depends(get_db)):
    paths = _some_paths(data.paths)
    store = await _ready_store()
    deleted = await asyncio.to_thread(photos.delete_paths, db, current_project_id(), store, paths)
    return {"deleted": deleted}


@api_project.post("/photos/colors")
async def photos_set_colors(data: PhotoColorsBody, db: Session = Depends(get_db)):
    rel = photos.validate_path(data.path)
    if data.colors is _NO_COLORS:
        raise _bad_request("colors must be an object or null")
    await _ready_store()
    entry = await asyncio.to_thread(photos.set_colors, db, current_project_id(), rel, data.colors)
    return {"entry": entry}


@api_project.get("/photos/shares")
async def photos_shares(db: Session = Depends(get_db)):
    await _ready_store()
    shares = (
        db.query(PhotoShare)
        .filter(PhotoShare.project_id == current_project_id())
        .all()
    )
    shares.sort(key=lambda share: (photos.path_key(share.path), share.id))
    return {"shares": [photos.share_json(share) for share in shares]}


@api_project.post("/photos/shares")
async def photos_create_share(data: PhotoShareBody, db: Session = Depends(get_db)):
    if data.name is not None:
        if not isinstance(data.name, str) or not data.name.strip() or len(data.name.strip()) > MAX_SHARE_NAME_LENGTH:
            raise _bad_request(f"name must be text of 1 to {MAX_SHARE_NAME_LENGTH} characters")
        return {"share": photos.share_json(await _custom_share(db, data.path, data.name.strip()))}
    frame = _share_frame(db, data.frame_id)
    return {"share": photos.share_json(await _folder_share(db, data.path, frame.id if frame else None))}


async def _custom_share(db: Session, path: str, name: str) -> PhotoShare:
    """A new named link to the folder, every time: two links called the
    same are two links, each withdrawn on its own."""
    if path == "":
        raise _bad_request("Share a folder, not the whole library")
    rel = photos.validate_path(path)
    project_id = current_project_id()
    await _ready_store()
    await asyncio.to_thread(photos.assert_shareable_folder, db, project_id, rel)
    share = PhotoShare(project_id=project_id, path=rel, name=name, token=f"pk_{secrets.token_urlsafe(32)}")
    db.add(share)
    db.commit()
    db.refresh(share)
    return share


def _share_frame(db: Session, frame_id: Any) -> Frame | None:
    """The frame a link is for: None for the folder's general link."""
    if frame_id is None:
        return None
    if isinstance(frame_id, bool) or not isinstance(frame_id, int):
        raise _bad_request("frame_id must be a frame's id")
    frame = db.query(Frame).filter_by(project_id=current_project_id(), id=frame_id).first()
    if frame is None:
        raise _not_found("Frame not found")
    return frame


async def _folder_share(db: Session, path: str, frame_id: int | None = None) -> PhotoShare:
    """The folder's link for `frame_id` (its general link when None), made
    now unless it already has one. A folder has one general link and one
    per frame, so a frame's access can be withdrawn on its own."""
    if path == "":
        raise _bad_request("Share a folder, not the whole library")
    rel = photos.validate_path(path)
    project_id = current_project_id()
    await _ready_store()
    await asyncio.to_thread(photos.assert_shareable_folder, db, project_id, rel)
    share = (
        db.query(PhotoShare)
        .filter(
            PhotoShare.project_id == project_id,
            PhotoShare.path == rel,
            PhotoShare.frame_id == frame_id,
            PhotoShare.name.is_(None),
        )
        .order_by(PhotoShare.id.asc())
        .first()
    )
    if share is None:
        share = PhotoShare(
            project_id=project_id, path=rel, frame_id=frame_id, token=f"pk_{secrets.token_urlsafe(32)}"
        )
        db.add(share)
        db.commit()
        db.refresh(share)
    return share


def _frame_origin(frame: Frame) -> str:
    """The address this frame reaches the backend at (the SPA's shareUrlForFrame)."""
    host = (frame.server_host or "").strip()
    if not host:
        raise _bad_request("This frame does not know the address of this backend. Set it in the frame settings.")
    scheme = "https" if server_scheme_for_frame(frame) == "https" else "http"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = f":{frame.server_port}" if frame.server_port else ""
    return f"{scheme}://{host}{port}"


@api_project.post("/photos/scene")
async def photos_album_scene(data: PhotoSceneBody, db: Session = Depends(get_db)):
    """A ready scene that plays the folder on one frame, with the frame's own
    share link to the folder in it (made now if it has none). Installing it
    is the frame routes' business."""
    seconds = DEFAULT_SECONDS if data.seconds is None else data.seconds
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 < seconds < float("inf"):
        raise _bad_request("seconds must be a positive number")
    order = "random" if data.order is None else data.order
    if order not in ORDER_VALUES:
        raise _bad_request(f"order must be one of {', '.join(ORDER_VALUES)}")
    fit = "cover" if data.fit is None else data.fit
    if fit not in FIT_VALUES:
        raise _bad_request(f"fit must be one of {', '.join(FIT_VALUES)}")
    if data.name is not None and (not isinstance(data.name, str) or len(data.name) > MAX_SCENE_NAME_LENGTH):
        raise _bad_request(f"name must be text of at most {MAX_SCENE_NAME_LENGTH} characters")
    if isinstance(data.frame_id, bool) or not isinstance(data.frame_id, int):
        raise _bad_request("frame_id is required: the scene's link is the address that frame uses to reach the backend")
    frame = db.query(Frame).filter_by(project_id=current_project_id(), id=data.frame_id).first()
    if frame is None:
        raise _not_found("Frame not found")
    origin = _frame_origin(frame)
    share = await _folder_share(db, data.path, frame.id)
    scene = build_photo_album_scene(
        name=(data.name or "").strip() or photos.base_name(share.path),
        album_url=origin + photos.share_url(share.token),
        seconds=seconds,
        order=order,
        fit=fit,
    )
    return {"scene": scene, "share": photos.share_json(share)}


@api_project.delete("/photos/shares/{token}")
async def photos_delete_share(token: str, db: Session = Depends(get_db)):
    await _ready_store()
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
        address,
        limit=SHARE_REQUESTS_PER_HOUR,
        window_seconds=SHARE_RATE_WINDOW_SECONDS,
    ):
        raise HTTPException(status_code=HTTPStatus.TOO_MANY_REQUESTS, detail="Too many requests")
    share = db.query(PhotoShare).filter(PhotoShare.token == token).first()
    if share is None:
        raise _not_found()
    folder = await asyncio.to_thread(photos.shared_folder, db, share)
    photos.touch_share_use(db, share)
    return folder


@api_public.get("/photos/shared/{token}")
async def photos_shared_listing(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    shared = await _shared_folder(request, token, db, redis)

    def build() -> dict:
        files, updated_at = photos.share_index(db, shared)
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
        files, _updated_at = photos.share_index(db, shared)
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
    row = await asyncio.to_thread(photos.shared_file_row, db, shared, rel)
    store = await _ready_store()
    name = photos.base_name(rel)
    content_type = row.content_type or photos.content_type_for(name)
    headers = inert_asset_headers(content_type, name, inline=True)
    # The URL carries the token: no shared cache keeps the bytes.
    headers["Cache-Control"] = "private, max-age=300"
    stored = await asyncio.to_thread(photos.fetch_object, store, row.object_key)
    return _bytes_response(stored, content_type, headers)
