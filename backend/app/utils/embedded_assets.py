"""Asset management for embedded (ESP32) frames.

Embedded frames have no SSH or agent: the backend talks to the device's own
HTTP API over the LAN (bearer auth with ``frame.server_api_key``, host
resolution falling back to ``embedded.lastBoot.ip``) via the shared
``frame_http`` machinery.

Device contract (paths relative to the device assets root, i.e. the SD card
mount):

* ``GET  /api/frames/{id}/assets``                    → ``{"assets": [{"path", "size", "mtime", "is_dir"}, ...], "mounted": bool}``
* ``GET  /api/frames/{id}/asset?path=<rel>``          → raw file bytes + content-type
* ``POST /api/frames/{id}/assets/upload?path=<rel>``  → raw request body is the file
* ``POST /api/frames/{id}/assets/mkdir``              → form ``path=<rel>``
* ``POST /api/frames/{id}/assets/delete``             → form ``path=<rel>`` (recursive)
* ``POST /api/frames/{id}/assets/rename``             → form ``src=<rel>&dst=<rel>``

The helpers below accept/return the ABSOLUTE paths the rest of the backend
(and the frontend) already uses — prefixed with ``frame.assets_path`` — and
convert to device-relative paths on the wire.
"""

from __future__ import annotations

import json
import os
import posixpath
from http import HTTPStatus
from typing import Any, Optional

from arq import ArqRedis as Redis
from fastapi import HTTPException

from app.models.frame import Frame
from app.utils.frame_http import _fetch_frame_http_bytes

_FORM_URLENCODED = {"Content-Type": "application/x-www-form-urlencoded"}
# Device statuses forwarded to the caller verbatim; anything else becomes 502.
_PASSTHROUGH_STATUSES = {
    HTTPStatus.BAD_REQUEST,
    HTTPStatus.NOT_FOUND,
    HTTPStatus.CONFLICT,
    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    HTTPStatus.INSUFFICIENT_STORAGE,
}


def embedded_assets_path(frame: Frame) -> str:
    return frame.assets_path or "/srv/assets"


def to_relative_asset_path(frame: Frame, full_path: str, *, allow_root: bool = False) -> str:
    """Validate that *full_path* sits inside the frame's assets root and return
    the device-relative path (no leading slash).

    Mirrors the normpath + trailing-separator checks of the asset routes so a
    sibling like ``/srv/assets-other`` can never pass as ``/srv/assets``.
    """
    assets_path = os.path.normpath(embedded_assets_path(frame))
    normalized = os.path.normpath(full_path or "")
    if normalized == assets_path:
        if allow_root:
            return ""
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")
    if not normalized.startswith(assets_path + os.sep):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")
    return normalized[len(assets_path) + 1:]


def _device_error(status: int, body: bytes) -> HTTPException:
    detail = body.decode("utf-8", errors="replace").strip()
    if status in _PASSTHROUGH_STATUSES:
        return HTTPException(status_code=status, detail=detail or f"Device returned HTTP {status}")
    suffix = f": {detail}" if detail else ""
    return HTTPException(
        status_code=HTTPStatus.BAD_GATEWAY,
        detail=f"Device returned HTTP {status}{suffix}",
    )


def _quote_rel(rel_path: str) -> str:
    from urllib.parse import quote

    return quote(rel_path, safe="")


async def list_assets(frame: Frame, redis: Redis) -> list[dict[str, Any]]:
    """List every file/directory on the device, with paths made absolute so the
    response matches the SSH/agent shape the frontend already renders."""
    status, body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=f"/api/frames/{frame.id}/assets",
    )
    if status != HTTPStatus.OK:
        raise _device_error(status, body)
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail="Device returned an invalid asset listing",
        )
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail="Device returned an invalid asset listing",
        )

    assets_root = embedded_assets_path(frame)
    assets: list[dict[str, Any]] = []
    for entry in payload.get("assets") or []:
        if not isinstance(entry, dict):
            continue
        rel = str(entry.get("path") or "").strip().lstrip("/")
        if not rel:
            continue
        full = posixpath.normpath(posixpath.join(assets_root, rel))
        # Never let a compromised device inject paths outside its assets root.
        if full != assets_root and not full.startswith(assets_root.rstrip("/") + "/"):
            continue
        if full == assets_root:
            continue
        size = entry.get("size")
        mtime = entry.get("mtime")
        assets.append({
            "path": full,
            "size": int(size) if isinstance(size, (int, float)) and not isinstance(size, bool) else 0,
            "mtime": int(mtime) if isinstance(mtime, (int, float)) and not isinstance(mtime, bool) else 0,
            "is_dir": bool(entry.get("is_dir")),
        })
    assets.sort(key=lambda a: a["path"])
    return assets


async def download_asset(frame: Frame, redis: Redis, full_path: str) -> tuple[bytes, str]:
    """Fetch one file's raw bytes from the device. Returns (bytes, content_type)."""
    rel = to_relative_asset_path(frame, full_path)
    status, body, headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=f"/api/frames/{frame.id}/asset?path={_quote_rel(rel)}",
    )
    if status != HTTPStatus.OK:
        raise _device_error(status, body)
    content_type = ""
    for key, value in (headers or {}).items():
        if str(key).lower() == "content-type":
            content_type = str(value)
            break
    return body, content_type or "application/octet-stream"


async def upload_asset(frame: Frame, redis: Redis, full_path: str, data: bytes) -> dict[str, Any]:
    """Upload raw bytes to the device (parent dirs auto-created, existing file
    replaced). Returns the device's stat dict for the new file when parseable."""
    rel = to_relative_asset_path(frame, full_path)
    status, body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=f"/api/frames/{frame.id}/assets/upload?path={_quote_rel(rel)}",
        method="POST",
        body=data,
        headers={"Content-Type": "application/octet-stream"},
    )
    if status not in (HTTPStatus.OK, HTTPStatus.CREATED):
        raise _device_error(status, body)
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    return payload if isinstance(payload, dict) else {}


async def _post_form(
    frame: Frame,
    redis: Redis,
    action: str,
    fields: dict[str, str],
) -> None:
    from urllib.parse import urlencode

    status, body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=f"/api/frames/{frame.id}/assets/{action}",
        method="POST",
        body=urlencode(fields),
        headers=dict(_FORM_URLENCODED),
    )
    if status != HTTPStatus.OK:
        raise _device_error(status, body)


async def make_dir(frame: Frame, redis: Redis, full_path: str) -> None:
    await _post_form(
        frame,
        redis,
        "mkdir",
        {"path": to_relative_asset_path(frame, full_path, allow_root=True)},
    )


async def delete_path(frame: Frame, redis: Redis, full_path: str) -> None:
    await _post_form(
        frame,
        redis,
        "delete",
        {"path": to_relative_asset_path(frame, full_path)},
    )


async def rename_path(frame: Frame, redis: Redis, src_full: str, dst_full: str) -> None:
    await _post_form(
        frame,
        redis,
        "rename",
        {
            "src": to_relative_asset_path(frame, src_full),
            "dst": to_relative_asset_path(frame, dst_full),
        },
    )


def thumbnail_jpeg(data: bytes, size: int = 320) -> Optional[bytes]:
    """Downscale *data* into a JPEG thumbnail with PIL. Returns None when the
    bytes cannot be decoded (or Pillow is unavailable) so callers can fall back
    to serving the original bytes."""
    try:
        from PIL import Image
    except ImportError:
        return None
    import io

    try:
        with Image.open(io.BytesIO(data)) as image:
            image.thumbnail((size, size))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            out = io.BytesIO()
            image.save(out, format="JPEG")
            return out.getvalue()
    except Exception:
        return None
