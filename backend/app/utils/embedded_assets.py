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
import re
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Any, Optional

import httpx
from arq import ArqRedis as Redis
from fastapi import HTTPException

from app.models.frame import Frame
from app.utils.env import get_env_float, get_env_int
from app.utils.frame_http import _fetch_frame_http_bytes

_FORM_URLENCODED = {"Content-Type": "application/x-www-form-urlencoded"}
_OCTET_STREAM = {"Content-Type": "application/octet-stream"}
# Device statuses forwarded to the caller verbatim; anything else becomes 502.
_PASSTHROUGH_STATUSES = {
    HTTPStatus.BAD_REQUEST,
    HTTPStatus.NOT_FOUND,
    HTTPStatus.CONFLICT,
    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    HTTPStatus.INSUFFICIENT_STORAGE,
}

# One backend→device request per chunk keeps each transfer well inside the
# frame HTTP timeouts on slow links (an 8MB single POST to an ESP32 on weak
# WiFi reliably outlives them).
EMBEDDED_UPLOAD_CHUNK_BYTES = get_env_int("FRAME_EMBEDDED_UPLOAD_CHUNK_BYTES", 256 * 1024)

# Upload requests get a far longer read/write budget than the 20s default:
# a 256KB chunk on a struggling link (weak RSSI, VPN hop, device mid-render)
# can legitimately take minutes. The device aborts a genuinely dead transfer
# itself after ~30s of zero bytes, so this mostly bounds slow-but-alive ones.
_UPLOAD_RW_TIMEOUT = get_env_float("FRAME_HTTP_UPLOAD_TIMEOUT", 180.0)
UPLOAD_TIMEOUT = httpx.Timeout(
    connect=get_env_float("FRAME_HTTP_CONNECT_TIMEOUT", 10.0),
    read=_UPLOAD_RW_TIMEOUT,
    write=_UPLOAD_RW_TIMEOUT,
    pool=get_env_float("FRAME_HTTP_POOL_TIMEOUT", 10.0),
)

_UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,47}$")


def valid_upload_id(upload_id: str) -> bool:
    return bool(_UPLOAD_ID_RE.fullmatch(upload_id or ""))


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


@dataclass
class AssetListing:
    """An asset listing plus whatever storage state the source reported.

    ``mounted`` is None whenever nothing said otherwise — SSH/agent frames,
    virtual frames and ESP32 firmware older than the flag. Only an explicit
    ``False`` means "the SD card is missing", and that is the one case worth
    telling the user about: an empty list then means "cannot see the card",
    not "the card is empty".
    """

    assets: list[dict[str, Any]] = field(default_factory=list)
    mounted: Optional[bool] = None

    @property
    def storage(self) -> Optional[dict[str, Any]]:
        """The storage state for API responses, or None when unknown."""
        return None if self.mounted is None else {"mounted": self.mounted}


async def list_assets(frame: Frame, redis: Redis) -> AssetListing:
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
    # Only SD-backed devices report "mounted"; a missing key stays unknown so
    # nothing warns about frames that never had a card to begin with.
    mounted = payload.get("mounted")
    return AssetListing(assets=assets, mounted=mounted if isinstance(mounted, bool) else None)


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


def _parse_device_payload(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    return payload if isinstance(payload, dict) else {}


async def _upload_asset_single(
    frame: Frame, redis: Redis, rel: str, data: bytes
) -> dict[str, Any]:
    status, body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=f"/api/frames/{frame.id}/assets/upload?path={_quote_rel(rel)}",
        method="POST",
        body=data,
        headers=dict(_OCTET_STREAM),
        timeout=UPLOAD_TIMEOUT,
    )
    if status not in (HTTPStatus.OK, HTTPStatus.CREATED):
        raise _device_error(status, body)
    return _parse_device_payload(body)


async def upload_asset_chunk(
    frame: Frame,
    redis: Redis,
    full_path: str,
    chunk: bytes,
    *,
    upload_id: str,
    chunk_index: int,
    offset: int,
    complete: bool,
) -> Optional[dict[str, Any]]:
    """Forward one chunk of a chunked upload to the device.

    Returns the device payload ({"pending": true, ...} for a non-final chunk,
    the final stat dict for the last one) — or None when the device firmware
    predates chunked uploads: legacy firmware ignores the chunk params, stores
    the chunk as the whole file and answers with a stat dict, which is only
    distinguishable on a non-final chunk (no "pending" key). Callers must then
    fall back to a single-shot upload of the full payload.
    """
    if not valid_upload_id(upload_id):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid upload id")
    rel = to_relative_asset_path(frame, full_path)
    status, body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=(
            f"/api/frames/{frame.id}/assets/upload?path={_quote_rel(rel)}"
            f"&upload_id={upload_id}&chunk_index={int(chunk_index)}"
            f"&offset={int(offset)}&complete={1 if complete else 0}"
        ),
        method="POST",
        body=chunk,
        headers=dict(_OCTET_STREAM),
        timeout=UPLOAD_TIMEOUT,
    )
    if status not in (HTTPStatus.OK, HTTPStatus.CREATED):
        raise _device_error(status, body)
    payload = _parse_device_payload(body)
    if not complete and not payload.get("pending"):
        return None
    return payload


async def upload_asset(frame: Frame, redis: Redis, full_path: str, data: bytes) -> dict[str, Any]:
    """Upload raw bytes to the device (parent dirs auto-created, existing file
    replaced). Returns the device's stat dict for the new file when parseable.

    Payloads larger than EMBEDDED_UPLOAD_CHUNK_BYTES are streamed as several
    chunk requests so no single device request outlives the HTTP timeouts."""
    rel = to_relative_asset_path(frame, full_path)
    if len(data) <= EMBEDDED_UPLOAD_CHUNK_BYTES:
        return await _upload_asset_single(frame, redis, rel, data)

    upload_id = uuid.uuid4().hex[:32]
    chunk_size = EMBEDDED_UPLOAD_CHUNK_BYTES
    total_chunks = (len(data) + chunk_size - 1) // chunk_size
    payload: Optional[dict[str, Any]] = {}
    for index in range(total_chunks):
        offset = index * chunk_size
        payload = await upload_asset_chunk(
            frame,
            redis,
            full_path,
            data[offset:offset + chunk_size],
            upload_id=upload_id,
            chunk_index=index,
            offset=offset,
            complete=index == total_chunks - 1,
        )
        if payload is None:
            # Legacy firmware without chunk support: one big request is the
            # only option it understands.
            return await _upload_asset_single(frame, redis, rel, data)
    return payload or {}


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
