"""Asset management for Linux frames the backend reaches only over their
admin HTTP API.

An adopted generic Buildroot card ships no FrameOS Remote and takes no SSH
from this backend (`frame_has_shell_access()` is false), so the SSH/Remote
asset paths in `app/api/frames.py` cannot even connect. The runtime's own
admin routes (`frameos/src/frameos/server/routes/admin_api_assets_routes.nim`)
do everything the Assets panel needs; this module speaks them with the cached
admin session (`_frame_admin_request`), the same way `embedded_assets` speaks
the ESP32 firmware's routes with the server key.

Device contract (all admin-session gated, frame id is always ``1``):

* ``GET  /api/frames/1/assets``                         → ``{"assets": [{"path" (ABSOLUTE), "size", "mtime", "is_dir"}, ...]}``
* ``GET  /api/frames/1/asset?path=<rel>[&thumb=1]``     → raw file bytes (``thumb=1``: a PNG the frame renders itself)
* ``POST /api/frames/1/assets/upload?upload_id=&chunk_index=&complete=&path=<subdir>&filename=<name>``
                                                        → raw body is one chunk, appended in order; ``complete=1`` moves the part into place
* ``POST /api/frames/1/assets/mkdir``                   → form ``path=<rel>``
* ``POST /api/frames/1/assets/delete``                  → form ``path=<rel>`` (recursive)
* ``POST /api/frames/1/assets/rename``                  → form ``src=<rel>&dst=<rel>``

Paths on the wire are relative to the frame's assets root: the resolver on
the device strips leading slashes and joins to the root, so an absolute
``/srv/assets/x`` sent as-is would land at ``/srv/assets/srv/assets/x``. The
helpers below accept and return the ABSOLUTE paths the rest of the backend
uses and convert at the edge, exactly like ``embedded_assets``.
"""

from __future__ import annotations

import json
import posixpath
import uuid
from http import HTTPStatus
from typing import Any, Optional
from urllib.parse import urlencode

from arq import ArqRedis as Redis
from fastapi import HTTPException

from app.models.frame import Frame
from app.utils.embedded_assets import (
    UPLOAD_TIMEOUT,
    AssetListing,
    _device_error,
    _quote_rel,
    embedded_assets_path as assets_root,
    to_relative_asset_path,
)
from app.utils.env import get_env_int
from app.utils.frame_http import _fetch_frame_http_bytes

_FORM_URLENCODED = {"Content-Type": "application/x-www-form-urlencoded"}
_OCTET_STREAM = {"Content-Type": "application/octet-stream"}

# The runtime caps one request body at 8 MB (server.nim MAX_HTTP_BODY_LEN);
# chunks stay well under it so a big photo never trips the cap.
ADMIN_API_UPLOAD_CHUNK_BYTES = get_env_int("FRAME_ADMIN_API_UPLOAD_CHUNK_BYTES", 2 * 1024 * 1024)

_DEVICE_FRAME_ID = 1


async def _admin_request(
    frame: Frame,
    redis: Redis,
    *,
    path: str,
    method: str = "GET",
    body: bytes | str | None = None,
    headers: dict[str, str] | None = None,
    timeout: Any = None,
) -> tuple[int, bytes, dict[str, str]]:
    # Imported here: app.api.frame_sync pulls in the API layer, which this
    # utility module must not load at import time.
    from app.api.frame_sync import _frame_admin_request

    return await _frame_admin_request(
        frame,
        redis,
        _fetch_frame_http_bytes,
        path=path,
        method=method,
        body=body,
        headers=headers,
        timeout=timeout,
    )


def _parse_payload(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    return payload if isinstance(payload, dict) else {}


def _absolute_device_path(root: str, raw: Any) -> Optional[str]:
    """The listing's path made absolute under *root*, or None when it is not
    ours (a compromised device must not inject paths outside its root)."""
    text = str(raw or "").strip()
    if not text:
        return None
    full = posixpath.normpath(text if text.startswith("/") else posixpath.join(root, text))
    if full == root or not full.startswith(root.rstrip("/") + "/"):
        return None
    return full


async def list_assets(frame: Frame, redis: Redis) -> AssetListing:
    """Every file and directory under the frame's assets root, absolute paths,
    sorted — the shape the SSH/Remote listing produces."""
    status, body, _headers = await _admin_request(frame, redis, path=f"/api/frames/{_DEVICE_FRAME_ID}/assets")
    if status != HTTPStatus.OK:
        raise _device_error(status, body)
    payload = _parse_payload(body)
    if not payload and body.strip() not in (b"", b"{}"):
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="Frame returned an invalid asset listing")
    root = posixpath.normpath(assets_root(frame))
    assets: list[dict[str, Any]] = []
    for entry in payload.get("assets") or []:
        if not isinstance(entry, dict):
            continue
        full = _absolute_device_path(root, entry.get("path"))
        if full is None:
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
    # A Linux frame's assets directory is always there; "mounted" is an
    # SD-card notion, so it stays unknown.
    return AssetListing(assets=assets, mounted=None)


async def download_asset(
    frame: Frame, redis: Redis, full_path: str, *, thumb: bool = False
) -> tuple[bytes, str]:
    """One file's bytes and content type. With ``thumb`` the frame renders
    (and caches) a PNG preview itself — no need to pull the original here."""
    rel = to_relative_asset_path(frame, full_path)
    path = f"/api/frames/{_DEVICE_FRAME_ID}/asset?path={_quote_rel(rel)}"
    if thumb:
        path += "&thumb=1"
    status, body, headers = await _admin_request(frame, redis, path=path)
    if status != HTTPStatus.OK:
        raise _device_error(status, body)
    content_type = ""
    for key, value in (headers or {}).items():
        if str(key).lower() == "content-type":
            content_type = str(value)
            break
    return body, content_type or "application/octet-stream"


async def upload_asset(frame: Frame, redis: Redis, full_path: str, data: bytes) -> dict[str, Any]:
    """Store *data* at *full_path* (parents created, an existing file
    replaced). Always the device's chunked protocol — one request per
    ADMIN_API_UPLOAD_CHUNK_BYTES, ``complete=1`` on the last — so no single
    request approaches the runtime's body cap. Returns the device's stat
    payload for the stored file."""
    rel = to_relative_asset_path(frame, full_path)
    subdir, filename = posixpath.split(rel)
    if not filename:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")
    upload_id = uuid.uuid4().hex[:32]
    chunk_size = max(1, ADMIN_API_UPLOAD_CHUNK_BYTES)
    total_chunks = max(1, (len(data) + chunk_size - 1) // chunk_size)
    payload: dict[str, Any] = {}
    for index in range(total_chunks):
        chunk = data[index * chunk_size:(index + 1) * chunk_size]
        complete = index == total_chunks - 1
        query = urlencode({
            "upload_id": upload_id,
            "chunk_index": index,
            "complete": "1" if complete else "0",
            "path": subdir,
            "filename": filename,
        })
        status, body, _headers = await _admin_request(
            frame,
            redis,
            path=f"/api/frames/{_DEVICE_FRAME_ID}/assets/upload?{query}",
            method="POST",
            body=chunk,
            headers=dict(_OCTET_STREAM),
            timeout=UPLOAD_TIMEOUT,
        )
        if status not in (HTTPStatus.OK, HTTPStatus.CREATED):
            raise _device_error(status, body)
        payload = _parse_payload(body)
    return payload


async def _post_form(frame: Frame, redis: Redis, action: str, fields: dict[str, str]) -> None:
    status, body, _headers = await _admin_request(
        frame,
        redis,
        path=f"/api/frames/{_DEVICE_FRAME_ID}/assets/{action}",
        method="POST",
        body=urlencode(fields),
        headers=dict(_FORM_URLENCODED),
    )
    if status != HTTPStatus.OK:
        raise _device_error(status, body)


async def make_dir(frame: Frame, redis: Redis, full_path: str) -> None:
    await _post_form(frame, redis, "mkdir", {"path": to_relative_asset_path(frame, full_path, allow_root=True)})


async def delete_path(frame: Frame, redis: Redis, full_path: str) -> None:
    await _post_form(frame, redis, "delete", {"path": to_relative_asset_path(frame, full_path)})


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
