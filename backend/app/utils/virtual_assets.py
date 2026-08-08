"""Asset storage for virtual frames.

Virtual frames have no hardware, so their assets live on the backend itself:
one directory per frame under ``FRAMEOS_VIRTUAL_ASSETS_DIR`` (default
``../db/virtual_assets``, next to the SQLite database so docker installs keep
it on the persistent volume).

The helpers mirror ``app.utils.embedded_assets`` — same names, same
signatures, same absolute-path convention (paths prefixed with
``frame.assets_path``) — so the asset routes dispatch to either module
interchangeably. The ``redis`` parameter is unused here and kept only for
that symmetry.

Uploads are quota-limited per frame: ``device_config.assetsQuotaMb`` (edited
in the frame's settings panel), defaulting to 100 MB. Exceeding it returns
507 Insufficient Storage, the same status a full SD card produces on embedded
frames.
"""

from __future__ import annotations

import mimetypes
import os
import shutil
import tempfile
from http import HTTPStatus
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.models.frame import Frame
from app.utils.embedded_assets import embedded_assets_path, to_relative_asset_path

DEFAULT_QUOTA_MB = 100


def _storage_base() -> Path:
    return Path(os.environ.get("FRAMEOS_VIRTUAL_ASSETS_DIR") or "../db/virtual_assets")


def frame_assets_dir(frame: Frame) -> Path:
    """Physical directory holding this frame's assets (may not exist yet)."""
    return _storage_base() / f"frame_{int(frame.id)}"


def quota_bytes(frame: Frame) -> int:
    device_config = frame.device_config if isinstance(frame.device_config, dict) else {}
    quota = device_config.get("assetsQuotaMb")
    # The settings form may deliver the number as a string; be lenient.
    if isinstance(quota, str):
        try:
            quota = float(quota)
        except ValueError:
            quota = None
    if isinstance(quota, (int, float)) and not isinstance(quota, bool) and quota > 0:
        return int(quota * 1024 * 1024)
    return DEFAULT_QUOTA_MB * 1024 * 1024


def usage_bytes(frame: Frame) -> int:
    total = 0
    root = frame_assets_dir(frame)
    if not root.is_dir():
        return 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                continue
    return total


def _physical_path(frame: Frame, full_path: str, *, allow_root: bool = False) -> Path:
    """Map an absolute logical path (``/srv/assets/...``) to the on-disk file,
    re-checking containment after resolution so nothing escapes the frame dir."""
    rel = to_relative_asset_path(frame, full_path, allow_root=allow_root)
    root = frame_assets_dir(frame)
    target = (root / rel) if rel else root
    resolved_root = root.resolve()
    if not target.resolve().is_relative_to(resolved_root):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")
    return target


async def list_assets(frame: Frame, redis=None) -> list[dict[str, Any]]:
    root = frame_assets_dir(frame)
    assets_root = embedded_assets_path(frame).rstrip("/")
    assets: list[dict[str, Any]] = []
    if not root.is_dir():
        return assets
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            try:
                mtime = int(path.stat().st_mtime)
            except OSError:
                mtime = 0
            assets.append({
                "path": f"{assets_root}/{rel}",
                "size": 0,
                "mtime": mtime,
                "is_dir": True,
            })
        for name in filenames:
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            try:
                stat = path.stat()
                size, mtime = int(stat.st_size), int(stat.st_mtime)
            except OSError:
                size, mtime = 0, 0
            assets.append({
                "path": f"{assets_root}/{rel}",
                "size": size,
                "mtime": mtime,
                "is_dir": False,
            })
    assets.sort(key=lambda a: a["path"])
    return assets


async def download_asset(frame: Frame, redis, full_path: str) -> tuple[bytes, str]:
    target = _physical_path(frame, full_path)
    if not target.is_file():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return target.read_bytes(), content_type


async def upload_asset(frame: Frame, redis, full_path: str, data: bytes) -> dict[str, Any]:
    target = _physical_path(frame, full_path)
    if target.is_dir():
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="Path is a directory")

    replaced = 0
    if target.is_file():
        try:
            replaced = target.stat().st_size
        except OSError:
            replaced = 0
    quota = quota_bytes(frame)
    projected = usage_bytes(frame) - replaced + len(data)
    if projected > quota:
        raise HTTPException(
            status_code=HTTPStatus.INSUFFICIENT_STORAGE,
            detail=(
                f"Assets quota exceeded: upload needs {projected} bytes, "
                f"quota is {quota} bytes"
            ),
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a crashed upload never leaves a truncated asset.
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".upload-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp_name, target)
    except OSError:
        _unlink_quietly(tmp_name)
        raise
    return {
        "path": full_path,
        "size": len(data),
        "mtime": int(target.stat().st_mtime),
        "is_dir": False,
    }


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


async def make_dir(frame: Frame, redis, full_path: str) -> None:
    target = _physical_path(frame, full_path, allow_root=True)
    if target.is_file():
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="Path is a file")
    target.mkdir(parents=True, exist_ok=True)


async def delete_path(frame: Frame, redis, full_path: str) -> None:
    target = _physical_path(frame, full_path)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.is_file():
        target.unlink()
    else:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")


async def rename_path(frame: Frame, redis, src_full: str, dst_full: str) -> None:
    src = _physical_path(frame, src_full)
    dst = _physical_path(frame, dst_full)
    if not src.exists():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")
    if dst.exists():
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="Destination already exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)


def delete_frame_assets(frame: Frame) -> None:
    """Remove the whole storage directory (frame deletion)."""
    root = frame_assets_dir(frame)
    if root.is_dir():
        shutil.rmtree(root, ignore_errors=True)
