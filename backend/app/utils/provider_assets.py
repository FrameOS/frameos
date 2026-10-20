"""Asset management for frames this backend is the provider of.

A provider frame's Assets panel rides the contract's asset verbs on its
management socket (docs/cloud-frames.md: `assets_list`, `asset_get`,
`asset_put`, `asset_put_chunk`, `asset_mkdir`, `asset_delete`,
`asset_rename`), exactly as on FrameOS Cloud. Same function signatures as
`embedded_assets`, `admin_api_assets` and `virtual_assets`, so the routes in
app/api/frames.py pick a module and call it: absolute paths in and out,
relative on the wire.

The device resolves and bounds every path itself (the verbs refuse a
traversal, an absolute path and a dot-directory write); the conversion here
is only so a path outside the frame's assets root is never even sent.
"""
from __future__ import annotations

import posixpath
from http import HTTPStatus
from typing import Any

from arq import ArqRedis as Redis
from fastapi import HTTPException

from app.database import SessionLocal
from app.models.frame import Frame
from app.utils.embedded_assets import AssetListing, embedded_assets_path as assets_root, to_relative_asset_path
from app.utils.provider_commands import (
    ProviderCommandError,
    provider_asset_write,
    provider_get_file,
    provider_list_assets,
    provider_upload_asset,
)

_ERROR_STATUS: dict[str, int] = {
    "frame_offline": HTTPStatus.SERVICE_UNAVAILABLE,
    "frame_not_responding": HTTPStatus.SERVICE_UNAVAILABLE,
    "timeout": HTTPStatus.GATEWAY_TIMEOUT,
    "not_found": HTTPStatus.NOT_FOUND,
    "invalid_path": HTTPStatus.BAD_REQUEST,
    "is_directory": HTTPStatus.BAD_REQUEST,
    "too_large": HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    "busy": HTTPStatus.SERVICE_UNAVAILABLE,
}
_ERROR_DETAIL: dict[str, str] = {
    "frame_offline": "The frame is not connected; its assets are reachable while it is online",
    "frame_not_responding": "The frame did not answer",
}


def _own(db, frame: Frame) -> Frame:
    """The frame on this session (the caller's copy may be detached)."""
    own = db.get(Frame, int(frame.id))
    if own is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    return own


def _http_error(exc: ProviderCommandError) -> HTTPException:
    status = _ERROR_STATUS.get(exc.error, HTTPStatus.BAD_GATEWAY)
    return HTTPException(status_code=status, detail=_ERROR_DETAIL.get(exc.error, f"The frame answered: {exc.error}"))


def _absolute(root: str, rel: Any) -> str | None:
    text = str(rel or "").strip().lstrip("/")
    if not text:
        return None
    full = posixpath.normpath(posixpath.join(root, text))
    return full if full.startswith(root.rstrip("/") + "/") else None


def _entry(root: str, item: dict[str, Any]) -> dict[str, Any] | None:
    full = _absolute(root, item.get("path"))
    if full is None:
        return None
    size = item.get("size")
    mtime = item.get("mtime")
    return {
        "path": full,
        "size": int(size) if isinstance(size, (int, float)) and not isinstance(size, bool) else 0,
        "mtime": int(mtime) if isinstance(mtime, (int, float)) and not isinstance(mtime, bool) else 0,
        "is_dir": bool(item.get("is_dir")),
    }


async def list_assets(frame: Frame, redis: Redis) -> AssetListing:
    root = posixpath.normpath(assets_root(frame))
    db = SessionLocal()
    try:
        result = await provider_list_assets(db, redis, _own(db, frame))
    except ProviderCommandError as exc:
        raise _http_error(exc)
    finally:
        db.close()
    assets = [entry for item in result.get("assets") or [] if isinstance(item, dict) and (entry := _entry(root, item))]
    assets.sort(key=lambda a: a["path"])
    return AssetListing(assets=assets, mounted=None)


async def list_assets_folder(frame: Frame, redis: Redis, folder_full: str) -> list[dict[str, Any]]:
    """The direct children of one folder: the device lists everything, the
    folder is cut out here (the Linux runtime's listing is capped at 5000)."""
    listing = await list_assets(frame, redis)
    prefix = posixpath.normpath(folder_full).rstrip("/") + "/"
    return [a for a in listing.assets if a["path"].startswith(prefix) and "/" not in a["path"][len(prefix):]]


async def download_asset(frame: Frame, redis: Redis, full_path: str, *, thumb: bool = False) -> tuple[bytes, str]:
    payload: dict[str, Any] = {"path": to_relative_asset_path(frame, full_path)}
    if thumb:
        payload["thumb"] = True
    db = SessionLocal()
    try:
        data, content_type = await provider_get_file(db, redis, _own(db, frame), "asset_get", payload)
    except ProviderCommandError as exc:
        raise _http_error(exc)
    finally:
        db.close()
    return data, content_type or "application/octet-stream"


async def upload_asset(frame: Frame, redis: Redis, full_path: str, data: bytes) -> dict[str, Any]:
    rel = to_relative_asset_path(frame, full_path)
    db = SessionLocal()
    try:
        result = await provider_upload_asset(db, redis, _own(db, frame), rel, data)
    except ProviderCommandError as exc:
        raise _http_error(exc)
    finally:
        db.close()
    stat = result.get("asset")
    root = posixpath.normpath(assets_root(frame))
    entry = _entry(root, stat) if isinstance(stat, dict) else None
    return entry or {"path": full_path, "size": len(data), "mtime": 0, "is_dir": False}


async def _write(frame: Frame, redis: Redis, command_type: str, payload: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        await provider_asset_write(db, redis, _own(db, frame), command_type, payload)
    except ProviderCommandError as exc:
        raise _http_error(exc)
    finally:
        db.close()


async def make_dir(frame: Frame, redis: Redis, full_path: str) -> None:
    await _write(frame, redis, "asset_mkdir", {"path": to_relative_asset_path(frame, full_path)})


async def delete_path(frame: Frame, redis: Redis, full_path: str) -> None:
    await _write(frame, redis, "asset_delete", {"path": to_relative_asset_path(frame, full_path)})


async def rename_path(frame: Frame, redis: Redis, src_full: str, dst_full: str) -> None:
    await _write(frame, redis, "asset_rename", {
        "src": to_relative_asset_path(frame, src_full),
        "dst": to_relative_asset_path(frame, dst_full),
    })
