"""Photos on the self-hosted backend: the library of albums frames play.

`docs/photos.md` is the contract (routes, shapes, path rules, share links).
The rows are the cloud's: one `photo_entry` row per file and per folder
(app/models/photo_entry.py), share links in `photo_share`. The bytes live in
an object store (app/utils/object_store.py) under `photos/<sha256>`, with the
thumbnail under `photos/thumbs/<sha256>`: a directory next to the database
by default, or an S3-compatible bucket when the FRAMEOS_PHOTOS_S3_* variables
are set. Two uploads of one photo share one object; a row never holds a file
name the disk has to agree with.

Every mutation runs under a per-project lock, so the " (2)" name pick and the
subtree rewrite of a move see a library nobody else is changing. Objects are
written BEFORE the row that points at them and deleted AFTER the rows that
pointed at them are gone, and only when no other row still does.

Everything here is blocking (disk, bucket, database); the routes
(app/api/photos.py) run it in a worker thread.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import logging
import mimetypes
import os
import random
import re
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, Iterator, Optional
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import func, literal
from sqlalchemy.orm import Session

from app.config import DEFAULT_DATABASE_URL, get_bool_env
from app.models.photo_entry import PhotoEntry
from app.models.photo_share import PhotoShare
from app.utils.photo_metadata import strip_photo_metadata
from app.utils.object_store import (
    DiskObjectStore,
    ObjectStore,
    S3ObjectStore,
    StoreError,
    s3_settings_from_env,
)

log = logging.getLogger(__name__)

# A photographer's full-size file: 250 MiB, the same on the cloud
# (cloud/apps/auth-web/src/lib/photos/library.ts maxPhotoUploadBytes).
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_CHUNK_BYTES = 4 * 1024 * 1024
MAX_PATH_BYTES = 1024
MAX_SEGMENT_BYTES = 255
MAX_DEPTH = 32
MAX_SHARE_FILES = 10000
THUMB_MAX_SIDE = 512
# A thumbnail of a PNG (GIF, WebP, BMP) decodes the whole image first: a flat
# 13000 x 13000 PNG is a few hundred KB on disk and 700 MB of RGBA. Above
# this there is no thumbnail (the SPA shows the file itself). A JPEG is read
# through Pillow's draft mode, which decodes at a fraction of the size, so a
# camera's 100 MP file is cheap and the cap is higher (docs/photos.md).
THUMB_MAX_PIXELS = 80_000_000
THUMB_MAX_JPEG_PIXELS = 400_000_000
READINESS_CACHE_SECONDS = 30
UPLOAD_PART_MAX_AGE_SECONDS = 3600
SHARE_URL_PREFIX = "/api/photos/shared"
SHARE_ORDERS = ("random", "sequential", "newest", "oldest")
COLORS_SUFFIX = ".frameos.json"
MAX_COLORS_BYTES = 64 * 1024
# Resizing (docs/photos.md "POST /api/photos/resize"): the fits, the formats
# a photo can be re-encoded to, and the longest side a result may have.
RESIZE_FITS = ("inside", "cover", "contain", "fill")
RESIZE_FORMATS = ("keep", "jpeg", "png", "webp")
RESIZE_MAX_SIDE = 16384
RESIZE_EXTENSIONS = {"jpeg": ".jpg", "png": ".png", "webp": ".webp", "gif": ".gif", "bmp": ".bmp"}

_UPLOAD_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
_SHARE_TOKEN_RE = re.compile(r"pk_[A-Za-z0-9_-]{32,124}")
_DIGITS_RE = re.compile(r"(\d+)")
_MOUNTINFO_ESCAPE_RE = re.compile(r"\\([0-7]{3})")

# What a frame can decode, by extension (docs/photos.md "Playable").
PLAYABLE_CONTENT_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "webp": "image/webp",
    "qoi": "image/qoi",
    "ppm": "image/x-portable-pixmap",
}


# ---------------------------------------------------------------------------
# Where the bytes live
# ---------------------------------------------------------------------------


def photos_dir() -> Path:
    """The first of: FRAMEOS_PHOTOS_DIR, /data/photos on a Home Assistant
    add-on, `photos/` next to the SQLite database. Read per call so tests can
    point it somewhere else. Holds `objects/` (the disk store) and `.cache/`
    (unfinished uploads), whichever store is in use."""
    explicit = os.environ.get("FRAMEOS_PHOTOS_DIR")
    if explicit:
        return Path(os.path.abspath(explicit))
    if os.environ.get("HASSIO_TOKEN") and os.path.isdir("/data"):
        return Path("/data/photos")
    database_url = os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL
    if database_url.startswith("sqlite:///"):
        db_path = database_url[len("sqlite:///"):].split("?", 1)[0]
        return Path(os.path.abspath(os.path.join(os.path.dirname(db_path) or ".", "photos")))
    return Path(os.path.abspath(os.path.join("..", "db", "photos")))


def objects_dir() -> Path:
    return photos_dir() / "objects"


def cache_dir() -> Path:
    return photos_dir() / ".cache"


_STORE_LOCK = threading.Lock()
_STORE: Optional[tuple[tuple[Any, ...], ObjectStore]] = None


def object_store() -> tuple[Optional[ObjectStore], Optional[str]]:
    """(the configured store, None), or (None, why it cannot be built). One
    S3 client is kept for as long as the settings stay the same."""
    global _STORE
    settings, problem = s3_settings_from_env()
    if problem:
        return None, problem
    key: tuple[Any, ...] = (settings,) if settings else ("disk", str(objects_dir()))
    with _STORE_LOCK:
        if _STORE is not None and _STORE[0] == key:
            return _STORE[1], None
        store: ObjectStore = S3ObjectStore(settings) if settings else DiskObjectStore(objects_dir())
        _STORE = (key, store)
        return store, None


def file_object_key(sha256: str) -> str:
    return f"photos/{sha256}"


def thumb_object_key(sha256: str) -> str:
    return f"photos/thumbs/{sha256}"


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Readiness:
    ready: bool
    problem: Optional[str]
    message: Optional[str]
    location: str


def _running_in_docker() -> bool:
    return os.path.exists("/.dockerenv")


def _read_mountinfo() -> Optional[str]:
    try:
        return Path("/proc/self/mountinfo").read_text()
    except OSError:
        return None


def mount_point_of(path: str, mountinfo: str) -> Optional[str]:
    """The mount point `path` (an absolute, resolved path) lives on, from the
    text of /proc/self/mountinfo: the longest mount point that contains it."""
    best: Optional[str] = None
    for line in mountinfo.splitlines():
        fields = line.split(" ")
        if len(fields) < 5:
            continue
        mount_point = _MOUNTINFO_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 8)), fields[4])
        if not mount_point.startswith("/"):
            continue
        contains = (
            mount_point == "/"
            or path == mount_point
            or path.startswith(mount_point.rstrip("/") + "/")
        )
        if contains and (best is None or len(mount_point) > len(best)):
            best = mount_point
    return best


def photos_are_ephemeral(
    path: Path,
    *,
    mountinfo: Optional[str] = None,
    in_docker: Optional[bool] = None,
) -> bool:
    """True when the backend runs in Docker and `path` is not on a mounted
    volume: everything in it is gone when the container is recreated. A Home
    Assistant add-on's /data is persistent; FRAMEOS_PHOTOS_ALLOW_EPHEMERAL=1
    skips the check. When the mounts cannot be read, nothing is claimed."""
    if get_bool_env("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL"):
        return False
    if os.environ.get("HASSIO_TOKEN"):
        return False
    if in_docker is None:
        in_docker = _running_in_docker()
    if not in_docker:
        return False
    if mountinfo is None:
        mountinfo = _read_mountinfo()
    if not mountinfo:
        return False
    return mount_point_of(os.path.realpath(path), mountinfo) in (None, "/")


def check_ready() -> Readiness:
    """Build the store and prove it answers: a write in the directory, or a
    signed request to the bucket. The same for every project."""
    store, problem = object_store()
    if store is None:
        return Readiness(ready=False, problem="storage_misconfigured", message=problem, location="")
    location = store.location
    try:
        cache_dir().mkdir(parents=True, exist_ok=True)
    except OSError as error:
        reason = error.strerror or str(error)
        return Readiness(
            ready=False,
            problem="not_writable",
            message=(
                f"The photos folder {photos_dir()} cannot be created or written to ({reason}). "
                "Check that the backend can write there, or set FRAMEOS_PHOTOS_DIR to a folder it can write to."
            ),
            location=location,
        )
    failure = store.check()
    if failure is not None:
        if store.driver == "disk":
            return Readiness(
                ready=False,
                problem="not_writable",
                message=(
                    f"The photos folder {location} cannot be created or written to ({failure}). "
                    "Check that the backend can write there, or set FRAMEOS_PHOTOS_DIR to a folder it can write to."
                ),
                location=location,
            )
        return Readiness(
            ready=False,
            problem="storage_unavailable",
            message=f"The photo bucket cannot be used: {failure}",
            location=location,
        )
    if store.driver == "disk" and photos_are_ephemeral(photos_dir()):
        return Readiness(
            ready=False,
            problem="not_persistent",
            message=(
                f"The photos folder {photos_dir()} is inside the Docker container, so every photo would be lost "
                "when the container is recreated. Mount a volume there (the /app/db volume from "
                "docker-compose.yml covers it), set FRAMEOS_PHOTOS_DIR to a folder on a mounted volume, "
                "or set FRAMEOS_PHOTOS_ALLOW_EPHEMERAL=1 to use it anyway."
            ),
            location=location,
        )
    return Readiness(ready=True, problem=None, message=None, location=location)


def free_bytes(path: Path) -> Optional[int]:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return int(shutil.disk_usage(probe).free)
    except OSError:
        return None


def used_bytes(db: Session, project_id: int) -> int:
    total = (
        db.query(func.coalesce(func.sum(PhotoEntry.size_bytes), 0))
        .filter(PhotoEntry.project_id == project_id, PhotoEntry.kind == "file")
        .scalar()
    )
    return int(total or 0)


def status(db: Session, project_id: int) -> dict[str, Any]:
    readiness = check_ready()
    store, _problem = object_store()
    on_disk = store is not None and store.driver == "disk"
    return {
        "ready": readiness.ready,
        "problem": readiness.problem,
        "message": readiness.message,
        "location": readiness.location or None,
        "used_bytes": used_bytes(db, project_id),
        "quota_bytes": None,
        "free_bytes": free_bytes(objects_dir()) if on_disk else None,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "accepts": None,
        "scanning": [],
    }


# Keyed by the store's location: tests move the library between cases.
_READINESS_CACHE: dict[str, tuple[float, Readiness]] = {}
_READINESS_LOCK = threading.Lock()


def ready_store() -> ObjectStore:
    """The store, or 503 with the reason while it is not ready. The probe is
    repeated at most every 30 s: a page load asks for one thumbnail per
    photo."""
    now = time.monotonic()
    store, problem = object_store()
    key = store.location if store is not None else f"misconfigured:{problem}"
    with _READINESS_LOCK:
        cached = _READINESS_CACHE.get(key)
    if cached is None or now - cached[0] > READINESS_CACHE_SECONDS or not cached[1].ready:
        readiness = check_ready()
        with _READINESS_LOCK:
            if len(_READINESS_CACHE) > 100:
                _READINESS_CACHE.clear()
            _READINESS_CACHE[key] = (now, readiness)
    else:
        readiness = cached[1]
    if not readiness.ready or store is None:
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail=readiness.message)
    return store


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _segment_problem(name: str) -> Optional[str]:
    try:
        size = len(name.encode("utf-8"))
    except UnicodeEncodeError:
        return "Names must be valid UTF-8"
    if size < 1 or size > MAX_SEGMENT_BYTES:
        return f"Names must be 1 to {MAX_SEGMENT_BYTES} bytes long"
    if name.startswith("."):
        return "Names cannot start with a dot"
    if name.casefold().endswith(COLORS_SUFFIX):
        return "Names ending in .frameos.json are kept for color profiles"
    for ch in name:
        if ch in ("/", "\\") or ord(ch) < 0x20 or ord(ch) == 0x7F:
            return "Names cannot contain slashes or control characters"
    return None


def is_valid_name(name: str) -> bool:
    return _segment_problem(name) is None


def validate_name(name: Optional[str]) -> str:
    problem = _segment_problem(name or "")
    if problem:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=problem)
    return name or ""


def _path_problem(value: str) -> Optional[str]:
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return "Paths must be valid UTF-8"
    if size > MAX_PATH_BYTES:
        return f"Paths can be at most {MAX_PATH_BYTES} bytes long"
    if value.startswith("/") or value.endswith("/"):
        return "Paths cannot start or end with a slash"
    segments = value.split("/")
    if len(segments) > MAX_DEPTH:
        return f"Paths can be at most {MAX_DEPTH} folders deep"
    for segment in segments:
        problem = _segment_problem(segment)
        if problem:
            return problem
    return None


def validate_path(value: Optional[str], *, allow_root: bool = False) -> str:
    """A library path per docs/photos.md "Paths", or 400. The root is ""."""
    value = value if value is not None else ""
    if value == "":
        if allow_root:
            return ""
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="A path is required")
    problem = _path_problem(value)
    if problem:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=problem)
    return value


def path_within_limits(value: str) -> bool:
    return _path_problem(value) is None


def join_path(parent: str, name: str) -> str:
    return f"{parent}/{name}" if parent else name


def parent_path(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def base_name(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def is_at_or_below(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + "/")


def path_prefixes(path: str) -> list[str]:
    """Every folder on the way to `path`, the path itself last."""
    if not path:
        return []
    segments = path.split("/")
    return ["/".join(segments[: index + 1]) for index in range(len(segments))]


def path_depth(path: str) -> int:
    return 0 if path == "" else path.count("/") + 1


def content_type_for(name: str) -> str:
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if extension in PLAYABLE_CONTENT_TYPES:
        return PLAYABLE_CONTENT_TYPES[extension]
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def is_playable(name: str) -> bool:
    return "." in name and name.rsplit(".", 1)[-1].lower() in PLAYABLE_CONTENT_TYPES


def natural_key(name: str) -> tuple[tuple[Any, ...], str]:
    """Case insensitive, numbers in natural order ("2" before "10"); the name
    itself breaks ties so the order is total."""
    parts = _DIGITS_RE.split(name.casefold())
    return tuple(int(part) if index % 2 else part for index, part in enumerate(parts)), name


def path_key(path: str) -> list[tuple[tuple[Any, ...], str]]:
    """Natural order one segment at a time (a folder before its contents),
    the cloud's comparePhotoPaths."""
    return [natural_key(segment) for segment in path.split("/")]


def candidate_names(name: str) -> Iterator[str]:
    """`name`, then `stem (2).ext`, `stem (3).ext`, ..."""
    yield name
    stem, extension = os.path.splitext(name)
    for number in range(2, 100000):
        yield f"{stem} ({number}){extension}"


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

# The library is one process; a lock per project is the cloud's advisory
# lock. SQLite serializes the writes themselves.
_PROJECT_LOCKS: dict[int, threading.RLock] = {}
_PROJECT_LOCKS_LOCK = threading.Lock()


def project_lock(project_id: int) -> threading.RLock:
    with _PROJECT_LOCKS_LOCK:
        lock = _PROJECT_LOCKS.get(int(project_id))
        if lock is None:
            lock = _PROJECT_LOCKS[int(project_id)] = threading.RLock()
        return lock


def _below(path: str):
    """A filter for rows strictly below `path` ("" is everything). Not LIKE:
    SQLite's LIKE ignores case, and a name may hold its wildcards."""
    if path == "":
        return literal(True)
    prefix = path + "/"
    return func.substr(PhotoEntry.path, 1, len(prefix)) == prefix


def _at_or_below(path: str):
    return (PhotoEntry.path == path) | _below(path)


def _row_at(db: Session, project_id: int, path: str) -> Optional[PhotoEntry]:
    if path == "":
        return None
    return db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, PhotoEntry.path == path).first()


def _rows_below(db: Session, project_id: int, path: str) -> list[PhotoEntry]:
    return db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, _below(path)).all()


def _rows_at_or_below(db: Session, project_id: int, path: str) -> list[PhotoEntry]:
    return db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, _at_or_below(path)).all()


def _seconds(value: Optional[datetime.datetime]) -> int:
    if value is None:
        return 0
    if value.tzinfo is None:
        value = value.replace(tzinfo=datetime.timezone.utc)
    return int(value.timestamp())


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def _is_cover_image(row: PhotoEntry) -> bool:
    return row.kind == "file" and row.status == "ready" and bool((row.content_type or "").startswith("image/"))


def describe_children(parent: str, rows: list[PhotoEntry]) -> list[dict[str, Any]]:
    """Entries for the direct children of `parent` found in `rows`, which
    must hold every row below each child that should be counted (folder
    `items`, `files`, `size` and `cover` come from them). Folders first, then
    by name. The cloud's describePhotoChildren."""
    prefix = "" if parent == "" else parent + "/"
    children: list[PhotoEntry] = []
    stats: dict[str, dict[str, int]] = {}
    by_parent: dict[str, dict[str, list[PhotoEntry]]] = {}

    for row in rows:
        if not row.path.startswith(prefix) or len(row.path) == len(prefix):
            continue
        if "/" not in row.path[len(prefix):]:
            children.append(row)
            if row.kind == "folder":
                stats[row.path] = {"files": 0, "items": 0, "size": 0}
        group = by_parent.setdefault(parent_path(row.path), {"folders": [], "images": []})
        if row.kind == "folder":
            group["folders"].append(row)
        elif _is_cover_image(row):
            group["images"].append(row)

    for row in rows:
        relative = row.path[len(prefix):]
        slash = relative.find("/")
        if not row.path.startswith(prefix) or slash < 0:
            continue
        top = stats.get(prefix + relative[:slash])
        if top is None:
            continue
        if "/" not in relative[slash + 1:]:
            top["items"] += 1
        if row.kind == "file":
            top["files"] += 1
            top["size"] += int(row.size_bytes or 0)

    def by_name(row: PhotoEntry):
        return natural_key(base_name(row.path))

    def first_image(folder: str) -> Optional[str]:
        images = sorted(by_parent.get(folder, {}).get("images", []), key=by_name)
        return images[0].path if images else None

    # The first image among the direct children by name, else the first one
    # found in the subfolders by name, however deep (docs/photos.md).
    def cover_of(folder: str) -> Optional[str]:
        direct = first_image(folder)
        if direct:
            return direct
        for subfolder in sorted(by_parent.get(folder, {}).get("folders", []), key=by_name):
            nested = cover_of(subfolder.path)
            if nested:
                return nested
        return None

    children.sort(key=lambda row: (0 if row.kind == "folder" else 1, by_name(row)))
    entries: list[dict[str, Any]] = []
    for row in children:
        base = {"path": row.path, "name": base_name(row.path), "mtime": _seconds(row.created_at)}
        if row.kind == "folder":
            folder_stats = stats.get(row.path, {"files": 0, "items": 0, "size": 0})
            entries.append({
                **base,
                "kind": "folder",
                "size": folder_stats["size"],
                "items": folder_stats["items"],
                "files": folder_stats["files"],
                "cover": cover_of(row.path),
                "width": None,
                "height": None,
                "content_type": None,
                "status": row.status,
            })
        else:
            entries.append({
                **base,
                "kind": "file",
                "size": int(row.size_bytes or 0),
                "width": row.width,
                "height": row.height,
                "content_type": row.content_type,
                "status": row.status,
                "colors": row.colors if row.colors else None,
            })
    return entries


def entry_for(db: Session, project_id: int, path: str) -> Optional[dict[str, Any]]:
    """One entry, in the listing shape, or None when nothing is there."""
    if path == "":
        return None
    rows = _rows_at_or_below(db, project_id, path)
    for entry in describe_children(parent_path(path), rows):
        if entry["path"] == path:
            return entry
    return None


def list_folder(db: Session, project_id: int, folder: str) -> dict[str, Any]:
    """The direct children of a folder (the root is ""). 404 for no such folder."""
    if folder != "":
        row = _row_at(db, project_id, folder)
        if row is None or row.kind != "folder":
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Folder not found")
    return {"path": folder, "entries": describe_children(folder, _rows_below(db, project_id, folder))}


def file_row(db: Session, project_id: int, path: str) -> PhotoEntry:
    """A file's row, for the owner's file, thumbnail and colors routes, or 404."""
    row = _row_at(db, project_id, path)
    if row is None or row.kind != "file":
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="File not found")
    return row


# ---------------------------------------------------------------------------
# Images: size and thumbnail, from bytes
# ---------------------------------------------------------------------------


def image_size_of(data: bytes) -> tuple[Optional[int], Optional[int]]:
    """Width and height from the image header (EXIF rotation applied, as a
    browser shows it), or (None, None)."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            try:
                orientation = image.getexif().get(0x0112)
            except Exception:
                orientation = None
            if orientation in (5, 6, 7, 8):
                width, height = height, width
            return width, height
    except Exception:
        return None, None


def thumbnail_of(data: bytes, name: str) -> Optional[bytes]:
    """A JPEG of at most 512 px on the long side, turned by the EXIF
    orientation, transparency on white (what the cloud's sharp makes); None
    for anything Pillow cannot read or an image over its format's cap: a
    JPEG is read through draft mode, which decodes at a fraction of its
    size, so it may have THUMB_MAX_JPEG_PIXELS; the rest decode whole and
    stop at THUMB_MAX_PIXELS."""
    if not content_type_for(name).startswith("image/"):
        return None
    try:
        from PIL import Image, ImageOps

        # Pillow refuses to open anything over twice its own pixel ceiling
        # (178 MP); ours is the decision here, taken on the header.
        bomb_limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = THUMB_MAX_JPEG_PIXELS
        try:
            opened = Image.open(io.BytesIO(data))
        finally:
            Image.MAX_IMAGE_PIXELS = bomb_limit
        with opened:
            cap = THUMB_MAX_JPEG_PIXELS if opened.format == "JPEG" else THUMB_MAX_PIXELS
            if opened.size[0] * opened.size[1] > cap:
                return None
            opened.draft("RGB", (THUMB_MAX_SIDE, THUMB_MAX_SIDE))
            # Shrink first: the transpose copies the image at its size.
            opened.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE))
            image = ImageOps.exif_transpose(opened)
            if image.mode not in ("RGB", "L"):
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, (255, 255, 255))
                image.paste(rgba, mask=rgba.getchannel("A"))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=82)
            return buffer.getvalue()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Folders and names
# ---------------------------------------------------------------------------


def _touch_folder(db: Session, project_id: int, folder: str) -> None:
    """The folder's updated_at says "something directly inside changed",
    which is what a share link's `updated_at` is built from."""
    if folder == "":
        return
    db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, PhotoEntry.path == folder).update(
        {PhotoEntry.updated_at: _utcnow()}, synchronize_session="fetch"
    )


def _ensure_folders(db: Session, project_id: int, folder: str) -> int:
    """Create the folder and every missing folder above it."""
    prefixes = path_prefixes(folder)
    if not prefixes:
        return 0
    existing = {
        row.path: row.kind
        for row in db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, PhotoEntry.path.in_(prefixes)).all()
    }
    missing: list[str] = []
    for prefix in prefixes:
        kind = existing.get(prefix)
        if kind == "file":
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"{prefix} is a file")
        if kind is None:
            missing.append(prefix)
    now = _utcnow()
    for path in missing:
        db.add(PhotoEntry(project_id=project_id, path=path, kind="folder", size_bytes=0, status="ready", created_at=now, updated_at=now))
    db.flush()
    return len(missing)


def _free_child_name(db: Session, project_id: int, folder: str, name: str) -> str:
    """`name`, or the first free `name (n)` among the folder's children."""
    if _row_at(db, project_id, join_path(folder, name)) is None:
        return name
    prefix = "" if folder == "" else folder + "/"
    taken = {
        row.path[len(prefix):]
        for row in _rows_below(db, project_id, folder)
        if "/" not in row.path[len(prefix):]
    }
    for candidate in candidate_names(name):
        if candidate not in taken:
            return candidate
    raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {name} is taken")


def create_folder(db: Session, project_id: int, path: str) -> dict[str, Any]:
    """POST /api/photos/folders: a new folder and its missing parents."""
    with project_lock(project_id):
        if _row_at(db, project_id, path) is not None:
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="Something with that name is already there")
        _ensure_folders(db, project_id, path)
        _touch_folder(db, project_id, parent_path(path))
        db.commit()
    return entry_for(db, project_id, path) or {}


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------


def valid_upload_id(upload_id: str) -> bool:
    return bool(_UPLOAD_ID_RE.fullmatch(upload_id or ""))


def upload_part_path(project_id: int, upload_id: str) -> Path:
    return cache_dir() / "uploads" / f"project_{int(project_id)}-{upload_id}.part"


def cleanup_stale_parts(now: Optional[float] = None) -> None:
    current = now if now is not None else time.time()
    _unlink_older_than(cache_dir() / "uploads", current - UPLOAD_PART_MAX_AGE_SECONDS)


def _unlink_older_than(directory: Path, cutoff: float) -> None:
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                _unlink_older_than(Path(entry.path), cutoff)
            elif entry.stat(follow_symlinks=False).st_mtime < cutoff:
                os.unlink(entry.path)
        except OSError:
            continue


def _unlink_quietly(path: str | Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def write_chunk(project_id: int, upload_id: str, offset: int, chunk: bytes) -> int:
    """Write one chunk of an upload at `offset`; returns the bytes received.
    A chunk that does not start where the previous one ended is a 409 (the
    part is gone or bytes were lost), and the client starts over."""
    part = upload_part_path(project_id, upload_id)
    part.parent.mkdir(parents=True, exist_ok=True)
    cleanup_stale_parts()
    if offset + len(chunk) > MAX_UPLOAD_BYTES:
        _unlink_quietly(part)
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="Uploaded file too large")
    if offset == 0:
        with open(part, "wb") as handle:
            handle.write(chunk)
        return len(chunk)
    try:
        received = part.stat().st_size
    except OSError:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="chunk_gap")
    if received != offset:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="chunk_gap")
    with open(part, "ab") as handle:
        handle.write(chunk)
    return offset + len(chunk)


def take_upload(project_id: int, upload_id: str) -> bytes:
    """The finished part's bytes, removed from the cache. A second
    complete=1 for the same upload finds nothing: 409, the client starts
    over."""
    part = upload_part_path(project_id, upload_id)
    part.parent.mkdir(parents=True, exist_ok=True)
    fd, claimed = tempfile.mkstemp(dir=part.parent, prefix=".finish-")
    os.close(fd)
    try:
        os.replace(part, claimed)
    except FileNotFoundError:
        _unlink_quietly(claimed)
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="chunk_gap")
    try:
        return Path(claimed).read_bytes()
    finally:
        _unlink_quietly(claimed)


def without_private_metadata(data: bytes, name: str) -> bytes:
    """The JPEG, PNG or WebP (sniffed, whatever the name says) without EXIF,
    XMP, text chunks or what follows the image, its orientation kept
    (app/utils/photo_metadata.py, docs/photos.md "POST /api/photos/upload").
    Anything else comes back as it is; so does a photo whose structure
    cannot be followed, with a warning: never worse than storing it whole."""
    stripped = strip_photo_metadata(data)
    if stripped.problem:
        log.warning("Photo %s kept its metadata, its %s structure could not be followed: %s", name, stripped.format, stripped.problem)
    return stripped.data


def store_file(
    db: Session,
    project_id: int,
    store: ObjectStore,
    folder: str,
    name: str,
    data: bytes,
    *,
    created_at: Optional[datetime.datetime] = None,
) -> dict[str, Any]:
    """Store one file: the objects first (the file, its thumbnail; an object
    already there is left alone, two uploads of one photo share it), then
    the row, with a " (2)" name when the name is taken. A photo loses its
    location and camera metadata first (without_private_metadata), so the
    object, its hash, size and thumbnail are of what is left."""
    data = without_private_metadata(data, name)
    digest = hashlib.sha256(data).hexdigest()
    object_key = file_object_key(digest)
    content_type = content_type_for(name)
    width, height = image_size_of(data) if content_type.startswith("image/") else (None, None)
    thumb_key: Optional[str] = None
    try:
        if not store.exists(object_key):
            store.put(object_key, data, content_type)
        thumbnail = thumbnail_of(data, name)
        if thumbnail is not None:
            thumb_key = thumb_object_key(digest)
            if not store.exists(thumb_key):
                store.put(thumb_key, thumbnail, "image/jpeg")
    except StoreError as error:
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail=f"The photo could not be stored: {error}")
    with project_lock(project_id):
        _ensure_folders(db, project_id, folder)
        free = _free_child_name(db, project_id, folder, name)
        target = join_path(folder, free)
        if not path_within_limits(target):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"Paths can be at most {MAX_PATH_BYTES} bytes long")
        now = _utcnow()
        db.add(PhotoEntry(
            project_id=project_id,
            path=target,
            kind="file",
            size_bytes=len(data),
            content_type=content_type,
            sha256=digest,
            object_key=object_key,
            thumb_object_key=thumb_key,
            width=width,
            height=height,
            status="ready",
            created_at=created_at or now,
            updated_at=now,
        ))
        _touch_folder(db, project_id, folder)
        db.commit()
    return entry_for(db, project_id, target) or {}


def finish_upload(db: Session, project_id: int, store: ObjectStore, folder: str, filename: str, upload_id: str) -> dict[str, Any]:
    return store_file(db, project_id, store, folder, filename, take_upload(project_id, upload_id))


# ---------------------------------------------------------------------------
# Move, rename, delete, colors
# ---------------------------------------------------------------------------


def _assert_subtree_fits(db: Session, project_id: int, source: str, target: str) -> None:
    """Everything below `source` moves with it: every new path must still be
    within the limits, or it could never be listed or addressed again."""
    for row in _rows_at_or_below(db, project_id, source):
        new_path = target + row.path[len(source):]
        if len(new_path.encode("utf-8")) > MAX_PATH_BYTES or path_depth(new_path) > MAX_DEPTH:
            raise HTTPException(
                status_code=HTTPStatus.BAD_REQUEST,
                detail=f"Something inside would be deeper than {MAX_DEPTH} folders or longer than {MAX_PATH_BYTES} bytes",
            )


def _rewrite_subtree(db: Session, project_id: int, source: str, target: str) -> None:
    """Rewrite the paths of `source` and everything below it, and of the
    share links pointing there. The caller made sure `target` is free."""
    now = _utcnow()
    tail = func.substr(PhotoEntry.path, len(source) + 1)
    # "fetch": the session keeps rows it loaded (expire_on_commit is off),
    # and the listing that answers this request must see the new paths.
    db.query(PhotoEntry).filter(PhotoEntry.project_id == project_id, _at_or_below(source)).update(
        {PhotoEntry.path: literal(target).concat(tail), PhotoEntry.updated_at: now}, synchronize_session="fetch"
    )
    for share in db.query(PhotoShare).filter(PhotoShare.project_id == project_id).all():
        if is_at_or_below(share.path, source):
            share.path = target + share.path[len(source):]


def _outermost(paths: list[str]) -> list[str]:
    """Drop paths that sit below another path in the same request: they
    travel with their folder."""
    unique = list(dict.fromkeys(paths))
    return [path for path in unique if not any(other != path and is_at_or_below(path, other) for other in unique)]


def move_paths(db: Session, project_id: int, paths: list[str], to: str) -> list[dict[str, str]]:
    with project_lock(project_id):
        if to != "":
            destination = _row_at(db, project_id, to)
            if destination is None:
                raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Destination folder not found")
            if destination.kind != "folder":
                raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="The destination is a file")
        # Every path is checked before anything moves.
        for path in dict.fromkeys(paths):
            row = _row_at(db, project_id, path)
            if row is None:
                raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"{path} not found")
            if row.kind == "folder" and is_at_or_below(to, path):
                raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="A folder cannot be moved into itself")
        moved_to: dict[str, str] = {}
        for source in _outermost(paths):
            parent = parent_path(source)
            if parent == to:
                moved_to[source] = source
                continue
            free = _free_child_name(db, project_id, to, base_name(source))
            target = join_path(to, free)
            _assert_subtree_fits(db, project_id, source, target)
            _rewrite_subtree(db, project_id, source, target)
            _touch_folder(db, project_id, parent)
            _touch_folder(db, project_id, to)
            moved_to[source] = target
        db.commit()
    moved: list[dict[str, str]] = []
    for source in dict.fromkeys(paths):
        direct = moved_to.get(source)
        if direct is not None:
            moved.append({"from": source, "to": direct})
            continue
        ancestor = next((path for path in moved_to if is_at_or_below(source, path)), source)
        moved.append({"from": source, "to": moved_to.get(ancestor, ancestor) + source[len(ancestor):]})
    return moved


def rename_path(db: Session, project_id: int, path: str, name: str) -> dict[str, Any]:
    target = validate_path(join_path(parent_path(path), name))
    with project_lock(project_id):
        row = _row_at(db, project_id, path)
        if row is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
        if target != path:
            if _row_at(db, project_id, target) is not None:
                raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {name} is taken")
            _assert_subtree_fits(db, project_id, path, target)
            _rewrite_subtree(db, project_id, path, target)
            _touch_folder(db, project_id, parent_path(path))
            db.commit()
    return entry_for(db, project_id, target) or {}


def set_colors(db: Session, project_id: int, path: str, colors: Any) -> dict[str, Any]:
    """Write or remove (None, {}) a photo's color profile. 400 for a folder
    or a file a frame cannot play, 404 for nothing there."""
    if colors is not None and not isinstance(colors, dict):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="colors must be an object or null")
    if colors:
        encoded = json.dumps(colors, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_COLORS_BYTES:
            raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="colors must be at most 64 KB as JSON")
    with project_lock(project_id):
        row = _row_at(db, project_id, path)
        if row is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="File not found")
        if row.kind != "file":
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Colors go on a file, not a folder")
        if not is_playable(base_name(path)):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Only images can have colors")
        row.colors = colors if colors else None
        # updated_at, not created_at: `mtime` stays the file's, while a share
        # link's `updated_at` says the album changed.
        row.updated_at = _utcnow()
        _touch_folder(db, project_id, parent_path(path))
        db.commit()
    return entry_for(db, project_id, path) or {}


@dataclass
class ResizeOptions:
    width: Optional[int]
    height: Optional[int]
    fit: str = "inside"
    format: str = "keep"
    quality: int = 85
    upscale: bool = False
    background: str = "#ffffff"
    # PNG only: reduce to a palette of this many colors (2 to 256), or keep every color.
    colors: Optional[int] = None


def _parse_background(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="background must be a #rrggbb color")
    digits = match.group(1)
    return int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)


def resize_box(
    source: tuple[int, int], width: Optional[int], height: Optional[int], fit: str, upscale: bool
) -> tuple[int, int]:
    """The canvas the result is drawn on. `inside` keeps the aspect and fits
    within the box (one side may be left out); the other fits take the box
    as it is. Without `upscale` nothing is invented: `inside` never grows
    the photo, and a box larger than the photo shrinks to fit inside it at
    the box's own aspect."""
    sw, sh = source
    if fit == "inside":
        bw = width or sw
        bh = height or sh
        scale = min(bw / sw, bh / sh)
        if not upscale:
            scale = min(scale, 1.0)
        return max(1, round(sw * scale)), max(1, round(sh * scale))
    bw, bh = width or sw, height or sh
    if not upscale and (bw > sw or bh > sh):
        scale = min(sw / bw, sh / bh)
        bw, bh = max(1, round(bw * scale)), max(1, round(bh * scale))
    return bw, bh


def resize_image_bytes(data: bytes, name: str, options: ResizeOptions) -> tuple[bytes, str, int, int]:
    """The photo re-drawn at the size `options` asks for, upright (the EXIF
    turn applied and dropped), encoded in the format asked for or the one it
    came in: (bytes, format name, width, height). 400 for a photo Pillow
    cannot read or a format it cannot write, 413 for one over its format's
    pixel cap."""
    try:
        from PIL import Image, ImageOps
    except ImportError:  # pragma: no cover - Pillow is a dependency
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail="Image support is not installed")

    bomb_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = THUMB_MAX_JPEG_PIXELS
    try:
        opened = Image.open(io.BytesIO(data))
    except Exception:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="This file is not an image that can be resized")
    finally:
        Image.MAX_IMAGE_PIXELS = bomb_limit
    with opened:
        source_format = (opened.format or "").lower()
        if source_format == "mpo":
            source_format = "jpeg"
        cap = THUMB_MAX_JPEG_PIXELS if source_format == "jpeg" else THUMB_MAX_PIXELS
        if opened.size[0] * opened.size[1] > cap:
            raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="This image is too large to resize")
        target_format = source_format if options.format == "keep" else options.format
        if target_format not in RESIZE_EXTENSIONS:
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"Images of type {source_format or 'unknown'} cannot be resized here")
        # The EXIF turn first, so the box is measured against the photo as it is seen.
        image = ImageOps.exif_transpose(opened) or opened
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.mode or image.mode == "P" else "RGB")
        bw, bh = resize_box(image.size, options.width, options.height, options.fit, options.upscale)
        if options.fit in ("inside", "fill"):
            image = image.resize((bw, bh), Image.Resampling.LANCZOS)
        elif options.fit == "cover":
            image = ImageOps.fit(image, (bw, bh), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        else:  # contain: fit within, pad to the box on the background
            scale = min(bw / image.size[0], bh / image.size[1])
            inner = (max(1, round(image.size[0] * scale)), max(1, round(image.size[1] * scale)))
            image = image.resize(inner, Image.Resampling.LANCZOS)
            rgb = _parse_background(options.background)
            fill: tuple[int, int, int] | tuple[int, int, int, int] = (rgb[0], rgb[1], rgb[2], 255) if image.mode == "RGBA" else rgb
            canvas = Image.new("RGBA" if image.mode == "RGBA" else "RGB", (bw, bh), fill)
            canvas.paste(image, ((bw - inner[0]) // 2, (bh - inner[1]) // 2))
            image = canvas
        buffer = io.BytesIO()
        quality = max(1, min(100, int(options.quality)))
        if target_format == "jpeg":
            if image.mode == "RGBA":
                flat = Image.new("RGB", image.size, _parse_background(options.background))
                flat.paste(image, mask=image.getchannel("A"))
                image = flat
            # Baseline, never progressive: the smallest frames decode a baseline JPEG in strips.
            image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=False)
        elif target_format == "png":
            if options.colors:
                image = image.quantize(colors=max(2, min(256, int(options.colors))), method=Image.Quantize.FASTOCTREE)
            image.save(buffer, format="PNG", optimize=True)
        elif target_format == "webp":
            image.save(buffer, format="WEBP", quality=quality, lossless=quality >= 100, method=4)
        elif target_format == "gif":
            image.convert("RGB").quantize(colors=256).save(buffer, format="GIF")
        else:  # bmp
            if image.mode == "RGBA":
                flat = Image.new("RGB", image.size, _parse_background(options.background))
                flat.paste(image, mask=image.getchannel("A"))
                image = flat
            image.save(buffer, format="BMP")
        return buffer.getvalue(), target_format, image.size[0], image.size[1]


def resize_photo(db: Session, project_id: int, store: ObjectStore, path: str, options: ResizeOptions) -> dict[str, Any]:
    """Replace a photo with itself resized (docs/photos.md "POST
    /api/photos/resize"): new bytes, thumbnail, size and dimensions, the
    same row otherwise (its colors, its place in the album, its date). A
    format change changes the extension; the returned entry has the path."""
    if options.fit not in RESIZE_FITS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"fit must be one of {', '.join(RESIZE_FITS)}")
    if options.format not in RESIZE_FORMATS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"format must be one of {', '.join(RESIZE_FORMATS)}")
    for side in (options.width, options.height):
        if side is not None and (not isinstance(side, int) or isinstance(side, bool) or side < 1 or side > RESIZE_MAX_SIDE):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"width and height must be whole numbers from 1 to {RESIZE_MAX_SIDE}")
    if options.width is None and options.height is None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Give a width, a height, or both")
    if options.fit != "inside" and (options.width is None or options.height is None):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"fit {options.fit} needs both a width and a height")
    _parse_background(options.background)
    row = _row_at(db, project_id, path)
    if row is None or row.kind != "file":
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="File not found")
    if not is_playable(base_name(path)) or not (row.content_type or "").startswith("image/"):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Only images can be resized")
    stored = fetch_object(store, row.object_key)
    data = stored.data if stored.data is not None else (stored.path.read_bytes() if stored.path else b"")
    resized, target_format, width, height = resize_image_bytes(data, base_name(path), options)
    # Pillow writes no EXIF or text here; the strip is the same rule as an upload's.
    resized = without_private_metadata(resized, base_name(path))
    digest = hashlib.sha256(resized).hexdigest()
    object_key = file_object_key(digest)
    new_name = base_name(path)
    stem, _dot, ext = new_name.rpartition(".")
    if RESIZE_EXTENSIONS.get(target_format) and content_type_for(new_name) != f"image/{target_format}":
        new_name = f"{stem or new_name}{RESIZE_EXTENSIONS[target_format]}"
    content_type = content_type_for(new_name)
    thumb_key: Optional[str] = None
    try:
        if not store.exists(object_key):
            store.put(object_key, resized, content_type)
        thumbnail = thumbnail_of(resized, new_name)
        if thumbnail is not None:
            thumb_key = thumb_object_key(digest)
            if not store.exists(thumb_key):
                store.put(thumb_key, thumbnail, "image/jpeg")
    except StoreError as error:
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail=f"The photo could not be stored: {error}")
    with project_lock(project_id):
        row = _row_at(db, project_id, path)
        if row is None or row.kind != "file":
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="File not found")
        old_keys = [row.object_key, row.thumb_object_key]
        folder = parent_path(path)
        target = path
        if new_name != base_name(path):
            target = join_path(folder, _free_child_name(db, project_id, folder, new_name))
            if not path_within_limits(target):
                raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"Paths can be at most {MAX_PATH_BYTES} bytes long")
        row.path = target
        row.size_bytes = len(resized)
        row.content_type = content_type
        row.sha256 = digest
        row.object_key = object_key
        row.thumb_object_key = thumb_key
        row.width = width
        row.height = height
        row.updated_at = _utcnow()
        _touch_folder(db, project_id, folder)
        db.commit()
        _delete_unreferenced_objects(db, store, [key for key in old_keys if key not in (object_key, thumb_key)])
    return entry_for(db, project_id, target) or {}


def _delete_unreferenced_objects(db: Session, store: ObjectStore, keys: list[Optional[str]]) -> None:
    """Objects whose rows are gone, unless another row (any project: objects
    are content addressed) still points at them. A store that refuses keeps
    the bytes; the row is gone either way."""
    for key in dict.fromkeys(key for key in keys if key):
        still_used = (
            db.query(PhotoEntry.id)
            .filter((PhotoEntry.object_key == key) | (PhotoEntry.thumb_object_key == key))
            .first()
        )
        if still_used is not None:
            continue
        try:
            store.delete(key)
        except StoreError:
            continue


def delete_paths(db: Session, project_id: int, store: ObjectStore, paths: list[str]) -> int:
    """Delete files and folders (with everything in them, and the share links
    at or below them). Paths that are already gone are skipped; the count is
    of the outermost paths that were there."""
    freed: list[Optional[str]] = []
    deleted = 0
    with project_lock(project_id):
        for path in _outermost(paths):
            rows = _rows_at_or_below(db, project_id, path)
            if not rows:
                continue
            deleted += 1
            for row in rows:
                freed.extend([row.object_key, row.thumb_object_key])
                db.delete(row)
            for share in db.query(PhotoShare).filter(PhotoShare.project_id == project_id).all():
                if is_at_or_below(share.path, path):
                    db.delete(share)
            db.flush()
            _touch_folder(db, project_id, parent_path(path))
        db.commit()
    _delete_unreferenced_objects(db, store, freed)
    return deleted


# ---------------------------------------------------------------------------
# Share links
# ---------------------------------------------------------------------------


def share_url(token: str) -> str:
    return f"{SHARE_URL_PREFIX}/{token}"


def share_json(share: PhotoShare) -> dict[str, Any]:
    return {
        "token": share.token,
        "path": share.path,
        "frame_id": share.frame_id,
        "name": share.name,
        "url": share_url(share.token),
        "created_at": _seconds(share.created_at) if share.created_at is not None else None,
        "last_used_at": _seconds(share.last_used_at) if share.last_used_at is not None else None,
    }


# How long a link's `last_used_at` stays put between reads: one write per
# minute per link, not one per photo a frame fetches.
SHARE_USE_TOUCH_SECONDS = 60


def touch_share_use(db: Session, share: PhotoShare) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    last = share.last_used_at
    if last is None or (now - last).total_seconds() >= SHARE_USE_TOUCH_SECONDS:
        share.last_used_at = now
        db.commit()


def valid_share_token(token: str) -> bool:
    return bool(_SHARE_TOKEN_RE.fullmatch(token or ""))


def assert_shareable_folder(db: Session, project_id: int, path: str) -> None:
    """400 for a file, 404 for nothing there."""
    row = _row_at(db, project_id, path)
    if row is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Folder not found")
    if row.kind != "folder":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Share a folder, not a file")


@dataclass
class SharedPhoto:
    path: str  # relative to the shared folder
    name: str
    row: PhotoEntry


@dataclass
class SharedFolder:
    project_id: int
    path: str
    name: str


def shared_folder(db: Session, share: PhotoShare) -> SharedFolder:
    """The folder a link points at, or 404 when it is gone."""
    if not share.path or _path_problem(share.path):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    row = _row_at(db, int(share.project_id), share.path)
    if row is None or row.kind != "folder":
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return SharedFolder(project_id=int(share.project_id), path=share.path, name=base_name(share.path))


def share_index(db: Session, shared: SharedFolder) -> tuple[list[SharedPhoto], int]:
    """Every playable file below the shared folder by path (natural order,
    at most MAX_SHARE_FILES), and when anything in it last changed."""
    photos: list[SharedPhoto] = []
    updated_at = 0
    prefix = shared.path + "/"
    for row in _rows_at_or_below(db, shared.project_id, shared.path):
        updated_at = max(updated_at, _seconds(row.updated_at))
        name = base_name(row.path)
        if row.kind != "file" or row.status != "ready" or not is_playable(name):
            continue
        photos.append(SharedPhoto(path=row.path[len(prefix):], name=name, row=row))
    photos.sort(key=lambda photo: path_key(photo.path))
    return photos[:MAX_SHARE_FILES], updated_at


def shared_photo_json(token: str, photo: SharedPhoto) -> dict[str, Any]:
    row = photo.row
    return {
        "path": photo.path,
        "name": photo.name,
        "url": f"{share_url(token)}/file?path={quote(photo.path, safe='')}",
        "size": int(row.size_bytes or 0),
        "mtime": _seconds(row.created_at),
        "width": row.width,
        "height": row.height,
        "content_type": row.content_type or content_type_for(photo.name),
        "colors": row.colors if row.colors else None,
    }


SHARE_SHAPES = ("landscape", "portrait", "square")


def photo_shape(width: Optional[int], height: Optional[int]) -> Optional[str]:
    """landscape, portrait or square by the photo's pixels; None when the
    dimensions are not known."""
    if not width or not height:
        return None
    if width > height:
        return "landscape"
    if height > width:
        return "portrait"
    return "square"


def parse_shapes(value: str) -> Optional[list[str]]:
    """`shapes=landscape,square` on the share routes and `shapes` in a scene
    body: the shapes to play, in SHARE_SHAPES order and without repeats.
    None for every shape (an empty value), or when the list names them all;
    ValueError for a name that is not a shape."""
    names = [name.strip() for name in value.split(",") if name.strip()]
    for name in names:
        if name not in SHARE_SHAPES:
            raise ValueError(f"shapes must be some of {', '.join(SHARE_SHAPES)}")
    chosen = [shape for shape in SHARE_SHAPES if shape in names]
    return None if not chosen or len(chosen) == len(SHARE_SHAPES) else chosen


def filter_shapes(photos: list[SharedPhoto], shapes: Optional[list[str]]) -> list[SharedPhoto]:
    """The photos of the chosen shapes. With every shape (None) nothing is
    dropped, a photo of unknown size included; with a choice, only photos
    whose size is known and fits."""
    if shapes is None:
        return photos
    return [photo for photo in photos if photo_shape(photo.row.width, photo.row.height) in shapes]


def pick_photo(photos: list[SharedPhoto], order: str, index: int, token: str) -> Optional[SharedPhoto]:
    """The photo at `index mod count` in `order`. `random` is a shuffle seeded
    by the token and the cycle (`index // count`): every photo once per cycle,
    a new order each cycle."""
    count = len(photos)
    if count == 0:
        return None
    position = index % count
    if order == "sequential":
        return photos[position]
    if order == "newest":
        return sorted(photos, key=lambda photo: (-_seconds(photo.row.created_at), path_key(photo.path)))[position]
    if order == "oldest":
        return sorted(photos, key=lambda photo: (_seconds(photo.row.created_at), path_key(photo.path)))[position]
    permutation = list(range(count))
    random.Random(f"{token}:{index // count}").shuffle(permutation)
    return photos[permutation[position]]


def shared_photo_at(db: Session, shared: SharedFolder, rel: str) -> Optional[SharedPhoto]:
    """One playable file below the shared folder, by its path relative to
    it, or None (a single-photo scene asks for its photo by path)."""
    if _path_problem(rel) or not is_playable(base_name(rel)):
        return None
    row = _row_at(db, shared.project_id, f"{shared.path}/{rel}")
    if row is None or row.kind != "file" or row.status != "ready":
        return None
    return SharedPhoto(path=rel, name=base_name(rel), row=row)


def shared_file_row(db: Session, shared: SharedFolder, rel: str) -> PhotoEntry:
    """A playable file below the shared folder, or 404."""
    if not is_playable(base_name(rel)):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    row = _row_at(db, shared.project_id, f"{shared.path}/{rel}")
    if row is None or row.kind != "file" or row.status != "ready" or not row.object_key:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return row


# ---------------------------------------------------------------------------
# Serving bytes
# ---------------------------------------------------------------------------


@dataclass
class StoredBytes:
    """What a route sends: a file to stream (the disk store) or the bytes."""

    path: Optional[Path]
    data: Optional[bytes]


def fetch_object(store: ObjectStore, key: Optional[str]) -> StoredBytes:
    """404 when the row names no object or the store has lost it."""
    if not key:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    local = store.local_path(key)
    if local is not None:
        return StoredBytes(path=local, data=None)
    try:
        data = store.get(key)
    except StoreError as error:
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail=f"The photo could not be read: {error}")
    if data is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return StoredBytes(path=None, data=data)
