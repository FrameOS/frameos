"""Photos on the self-hosted backend: the library of albums frames play.

`docs/photos.md` is the contract (routes, shapes, path rules, share links);
this module is the disk side of it. Files live in a plain folder, one per
project: `<photos dir>/project_<id>/<path>`, so files copied in by hand show
up in the library. Thumbnails and unfinished uploads live in
`<photos dir>/.cache`. Share links are rows in `photo_share`
(app/models/photo_share.py). A photo's color profile is a sidecar next to
it, `<photo>.frameos.json`, in the frame assets' format
(docs/asset-color-profiles.md); the path rules refuse that suffix, so a
sidecar is never listed and travels with its photo.

Everything here is blocking disk work; the routes (app/api/photos.py) run it
in a worker thread.
"""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import random
import re
import shutil
import stat as stat_module
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import timezone
from http import HTTPStatus
from pathlib import Path
from typing import Any, Iterator, Optional
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import DEFAULT_DATABASE_URL, get_bool_env
from app.models.photo_share import PhotoShare
# A photographer's full-size file: 250 MiB, the same on the cloud
# (cloud/apps/auth-web/src/lib/photos/library.ts maxPhotoUploadBytes).
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_CHUNK_BYTES = 4 * 1024 * 1024
MAX_PATH_BYTES = 1024
MAX_SEGMENT_BYTES = 255
MAX_DEPTH = 32
MAX_SHARE_FILES = 10000
THUMB_MAX_SIDE = 512
# A thumbnail decodes the whole image first: a flat 13000 x 13000 PNG is a
# few hundred KB on disk and 700 MB of RGBA. Above this there is no thumbnail
# (the SPA shows the file itself).
THUMB_MAX_PIXELS = 80_000_000
THUMB_MAX_AGE_SECONDS = 30 * 24 * 3600
READINESS_CACHE_SECONDS = 30
UPLOAD_PART_MAX_AGE_SECONDS = 3600
SHARE_URL_PREFIX = "/api/photos/shared"
SHARE_ORDERS = ("random", "sequential", "newest", "oldest")
COLORS_SUFFIX = ".frameos.json"
MAX_COLORS_BYTES = 64 * 1024

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
# Where the files live
# ---------------------------------------------------------------------------


def photos_dir() -> Path:
    """The first of: FRAMEOS_PHOTOS_DIR, /data/photos on a Home Assistant
    add-on, `photos/` next to the SQLite database. Read per call so tests can
    point it somewhere else."""
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


def project_root(project_id: int) -> Path:
    return photos_dir() / f"project_{int(project_id)}"


def cache_dir() -> Path:
    return photos_dir() / ".cache"


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


def check_ready(project_id: int) -> Readiness:
    """Create the project's folder and prove it can be written to."""
    root = project_root(project_id)
    location = str(root)
    try:
        root.mkdir(parents=True, exist_ok=True)
        cache_dir().mkdir(parents=True, exist_ok=True)
        fd, probe = tempfile.mkstemp(dir=root, prefix=".frameos-probe-")
        try:
            os.write(fd, b"ok")
        finally:
            os.close(fd)
            os.unlink(probe)
    except OSError as error:
        reason = error.strerror or str(error)
        return Readiness(
            ready=False,
            problem="not_writable",
            message=(
                f"The photos folder {location} cannot be created or written to ({reason}). "
                "Check that the backend can write there, or set FRAMEOS_PHOTOS_DIR to a folder it can write to."
            ),
            location=location,
        )
    if photos_are_ephemeral(root):
        return Readiness(
            ready=False,
            problem="not_persistent",
            message=(
                f"The photos folder {location} is inside the Docker container, so every photo would be lost "
                "when the container is recreated. Mount a volume there (the /app/db volume from "
                "docker-compose.yml covers it), set FRAMEOS_PHOTOS_DIR to a folder on a mounted volume, "
                "or set FRAMEOS_PHOTOS_ALLOW_EPHEMERAL=1 to use it anyway."
            ),
            location=location,
        )
    return Readiness(ready=True, problem=None, message=None, location=location)


def used_bytes(root: Path) -> int:
    """Everything stored under the project's folder, hidden files included."""
    total = 0
    stack = [str(root)]
    while stack:
        directory = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    return total


def free_bytes(path: Path) -> Optional[int]:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return int(shutil.disk_usage(probe).free)
    except OSError:
        return None


def status(project_id: int) -> dict[str, Any]:
    readiness = check_ready(project_id)
    root = project_root(project_id)
    return {
        "ready": readiness.ready,
        "problem": readiness.problem,
        "message": readiness.message,
        "location": readiness.location,
        "used_bytes": used_bytes(root) if root.is_dir() else 0,
        "quota_bytes": None,
        "free_bytes": free_bytes(root),
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "accepts": None,
        "scanning": [],
    }


# Keyed by project and location: tests move the library between cases.
_READINESS_CACHE: dict[tuple[int, str], tuple[float, Readiness]] = {}
_READINESS_LOCK = threading.Lock()


def ready_root(project_id: int) -> Path:
    """The project's folder, or 503 with the reason while it is not ready.
    The probe (a write in the folder) is repeated at most every 30 s per
    project: a page load asks for one thumbnail per photo."""
    now = time.monotonic()
    key = (int(project_id), str(project_root(project_id)))
    with _READINESS_LOCK:
        cached = _READINESS_CACHE.get(key)
    if cached is None or now - cached[0] > READINESS_CACHE_SECONDS or not cached[1].ready:
        readiness = check_ready(project_id)
        with _READINESS_LOCK:
            if len(_READINESS_CACHE) > 1000:
                _READINESS_CACHE.clear()
            _READINESS_CACHE[key] = (now, readiness)
    else:
        readiness = cached[1]
    if not readiness.ready:
        raise HTTPException(status_code=HTTPStatus.SERVICE_UNAVAILABLE, detail=readiness.message)
    return project_root(project_id)


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


def join_path(parent: str, name: str) -> str:
    return f"{parent}/{name}" if parent else name


def parent_path(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def base_name(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def is_at_or_below(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + "/")


def _inside(path: str, boundary: str) -> bool:
    return path == boundary or path.startswith(boundary.rstrip("/") + "/")


def disk_path(root: Path, rel: str, *, boundary: Optional[Path] = None) -> Path:
    """`rel` under `root` on disk, unresolved (so a symlink is the link
    itself). Whatever it resolves to must stay inside `boundary` (default the
    root): a symlink out of the library is not there (404)."""
    target = root / rel if rel else root
    limit = os.path.realpath(boundary or root)
    if not _inside(os.path.realpath(target), limit):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return target


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


def assert_subtree_fits(source: Path, new_rel: str) -> None:
    """A folder moved or renamed to `new_rel` takes its contents along: every
    descendant's new path must still be within the limits, or it could never
    be listed or addressed again (400, like the cloud)."""
    if not source.is_dir() or source.is_symlink():
        return
    base_depth = new_rel.count("/") + 1
    base_bytes = len(new_rel.encode("utf-8"))
    for directory, dirnames, filenames in os.walk(source):
        rel_dir = os.path.relpath(directory, source)
        below = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
        below_bytes = 0 if rel_dir == "." else len(rel_dir.encode("utf-8", "surrogateescape")) + 1
        for name in dirnames + filenames:
            depth = base_depth + below + 1
            size = base_bytes + below_bytes + 1 + len(name.encode("utf-8", "surrogateescape"))
            if depth > MAX_DEPTH or size > MAX_PATH_BYTES:
                raise HTTPException(
                    status_code=HTTPStatus.BAD_REQUEST,
                    detail=f"Something inside would be deeper than {MAX_DEPTH} folders or longer than {MAX_PATH_BYTES} bytes",
                )


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


@dataclass
class Child:
    name: str
    rel: str  # path in the library
    path: Path  # on disk, unresolved
    is_dir: bool
    stat: os.stat_result  # of what it points at
    has_colors: bool = False  # a file with a `<name>.frameos.json` next to it


def children(directory: Path, rel: str, boundary: str) -> list[Child]:
    """The visible entries of one folder. Hidden names, names the path rules
    refuse, entries past the length/depth limits and symlinks that resolve
    outside `boundary` (a resolved path) are not there."""
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return []
    # Sidecars fail the name rules, so they are seen here and nowhere else.
    sidecars = {entry.name for entry in entries if entry.name.endswith(COLORS_SUFFIX)}
    found: list[Child] = []
    for entry in entries:
        name = entry.name
        if not is_valid_name(name):
            continue
        child_rel = join_path(rel, name)
        if _path_problem(child_rel):
            continue
        try:
            if entry.is_symlink() and not _inside(os.path.realpath(entry.path), boundary):
                continue
            entry_stat = entry.stat(follow_symlinks=True)
        except OSError:
            continue
        if stat_module.S_ISDIR(entry_stat.st_mode):
            is_dir = True
        elif stat_module.S_ISREG(entry_stat.st_mode):
            is_dir = False
        else:
            continue
        found.append(
            Child(
                name=name,
                rel=child_rel,
                path=Path(entry.path),
                is_dir=is_dir,
                stat=entry_stat,
                has_colors=not is_dir and name + COLORS_SUFFIX in sidecars,
            )
        )
    return found


def walk(start: Path, start_rel: str, boundary: str) -> Iterator[Child]:
    """Every visible entry below `start`. Symlinked folders inside the
    boundary are followed, each real folder once."""
    try:
        start_stat = start.stat()
    except OSError:
        return
    visited = {(start_stat.st_dev, start_stat.st_ino)}
    stack = [(start, start_rel)]
    while stack:
        directory, rel = stack.pop()
        for child in children(directory, rel, boundary):
            yield child
            if child.is_dir:
                key = (child.stat.st_dev, child.stat.st_ino)
                if key not in visited:
                    visited.add(key)
                    stack.append((child.path, child.rel))


def sort_children(items: list[Child]) -> list[Child]:
    return sorted(items, key=lambda child: (0 if child.is_dir else 1, natural_key(child.name)))


_SIZE_CACHE: "OrderedDict[tuple[int, int, int, int], tuple[Optional[int], Optional[int]]]" = OrderedDict()
_SIZE_CACHE_LIMIT = 50000
_SIZE_CACHE_LOCK = threading.Lock()


def image_size(path: Path, file_stat: os.stat_result) -> tuple[Optional[int], Optional[int]]:
    """Width and height from the image header (EXIF rotation applied, as a
    browser shows it), or (None, None). Cached per file version."""
    key = (file_stat.st_dev, file_stat.st_ino, file_stat.st_mtime_ns, file_stat.st_size)
    with _SIZE_CACHE_LOCK:
        cached = _SIZE_CACHE.get(key)
        if cached is not None:
            _SIZE_CACHE.move_to_end(key)
            return cached
    width: Optional[int] = None
    height: Optional[int] = None
    try:
        from PIL import Image

        with Image.open(path) as image:
            width, height = image.size
            try:
                orientation = image.getexif().get(0x0112)
            except Exception:
                orientation = None
            if orientation in (5, 6, 7, 8):
                width, height = height, width
    except Exception:
        width, height = None, None
    with _SIZE_CACHE_LOCK:
        _SIZE_CACHE[key] = (width, height)
        while len(_SIZE_CACHE) > _SIZE_CACHE_LIMIT:
            _SIZE_CACHE.popitem(last=False)
    return width, height


def colors_file(path: Path) -> Path:
    """Where a photo's color profile lives: next to it, as a frame asset's."""
    return path.with_name(path.name + COLORS_SUFFIX)


def read_colors(path: Path) -> Optional[dict[str, Any]]:
    """The photo's color profile (the sidecar's `colors`), or None: no
    sidecar, a link, one too big or one that does not parse."""
    sidecar = colors_file(path)
    try:
        sidecar_stat = os.lstat(sidecar)
        if not stat_module.S_ISREG(sidecar_stat.st_mode) or sidecar_stat.st_size > MAX_COLORS_BYTES + 1024:
            return None
        root = json.loads(sidecar.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    colors = root.get("colors") if isinstance(root, dict) else None
    return colors if isinstance(colors, dict) and colors else None


def file_entry(
    rel: str, path: Path, file_stat: os.stat_result, has_colors: Optional[bool] = None
) -> dict[str, Any]:
    """`has_colors` is what the folder scan saw; None looks on disk."""
    name = base_name(rel)
    content_type = content_type_for(name)
    width, height = image_size(path, file_stat) if content_type.startswith("image/") else (None, None)
    return {
        "path": rel,
        "name": name,
        "kind": "file",
        "size": int(file_stat.st_size),
        "mtime": int(file_stat.st_mtime),
        "content_type": content_type,
        "width": width,
        "height": height,
        "status": "ready",
        "colors": read_colors(path) if has_colors is not False else None,
    }


def _first_playable(items: list[Child]) -> Optional[str]:
    files = [child for child in items if not child.is_dir and is_playable(child.name)]
    if not files:
        return None
    return min(files, key=lambda child: natural_key(child.name)).rel


def _cover(direct: list[Child], boundary: str) -> Optional[str]:
    """The first image among the direct children by name, else the first one
    found in the subfolders by name, however deep (docs/photos.md)."""
    cover = _first_playable(direct)
    if cover is not None:
        return cover
    for sub in sort_children([child for child in direct if child.is_dir]):
        cover = _cover(children(sub.path, sub.rel, boundary), boundary)
        if cover is not None:
            return cover
    return None


def folder_entry(rel: str, path: Path, folder_stat: os.stat_result, boundary: str) -> dict[str, Any]:
    direct = children(path, rel, boundary)
    files = 0
    size = 0
    for child in walk(path, rel, boundary):
        if not child.is_dir:
            files += 1
            size += int(child.stat.st_size)
    cover = _cover(direct, boundary)
    return {
        "path": rel,
        "name": base_name(rel),
        "kind": "folder",
        "size": size,
        "mtime": int(folder_stat.st_mtime),
        "content_type": None,
        "width": None,
        "height": None,
        "status": "ready",
        "items": len(direct),
        "files": files,
        "cover": cover,
    }


def entry_for(root: Path, rel: str) -> dict[str, Any]:
    target = disk_path(root, rel)
    try:
        target_stat = target.stat()
    except OSError:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    if stat_module.S_ISDIR(target_stat.st_mode):
        return folder_entry(rel, target, target_stat, os.path.realpath(root))
    return file_entry(rel, target, target_stat)


def list_folder(root: Path, rel: str) -> dict[str, Any]:
    folder = disk_path(root, rel)
    if not folder.is_dir():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Folder not found")
    boundary = os.path.realpath(root)
    entries = [
        folder_entry(child.rel, child.path, child.stat, boundary)
        if child.is_dir
        else file_entry(child.rel, child.path, child.stat, child.has_colors)
        for child in sort_children(children(folder, rel, boundary))
    ]
    return {"path": rel, "entries": entries}


def existing_file(root: Path, rel: str) -> Path:
    target = disk_path(root, rel)
    if not target.is_file():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="File not found")
    return target


# ---------------------------------------------------------------------------
# Thumbnails
# ---------------------------------------------------------------------------


def thumbnail_key(project_id: int, rel: str, file_stat: os.stat_result) -> str:
    raw = f"{int(project_id)}:{rel}:{file_stat.st_mtime_ns}:{file_stat.st_size}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def thumbnail(project_id: int, root: Path, rel: str) -> Optional[tuple[Path, str]]:
    """(the cached JPEG, its key) for an image, made on first request; None
    for anything Pillow cannot read."""
    source = existing_file(root, rel)
    if not content_type_for(source.name).startswith("image/"):
        return None
    source_stat = source.stat()
    key = thumbnail_key(project_id, rel, source_stat)
    target = cache_dir() / "thumbs" / f"project_{int(project_id)}" / f"{key}.jpg"
    if target.is_file():
        return target, key
    try:
        from PIL import Image, ImageOps

        with Image.open(source) as opened:
            if opened.size[0] * opened.size[1] > THUMB_MAX_PIXELS:
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
    except Exception:
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".thumb-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(buffer.getvalue())
        os.replace(tmp_name, target)
    except OSError:
        _unlink_quietly(tmp_name)
        return None
    return target, key


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def _unlink_quietly(path: str | Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _carry_colors(source: Optional[Path], target: Path) -> None:
    """A file arriving at `target` brings its own profile (from `source`) or
    none: a sidecar left at the new name (its photo removed by hand) must not
    color the newcomer."""
    old = colors_file(source) if source is not None else None
    if old is not None and os.path.lexists(old):
        os.replace(old, colors_file(target))
    else:
        _unlink_quietly(colors_file(target))


def set_colors(root: Path, rel: str, colors: Any) -> dict[str, Any]:
    """Write or remove (None, {}) a photo's color profile."""
    if disk_path(root, rel).is_dir():
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Colors go on a file, not a folder")
    target = existing_file(root, rel)
    if not is_playable(base_name(rel)):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Only images can have colors")
    if colors is not None and not isinstance(colors, dict):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="colors must be an object or null")
    sidecar = colors_file(target)
    if not colors:
        _unlink_quietly(sidecar)
        return entry_for(root, rel)
    encoded = json.dumps(colors, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_COLORS_BYTES:
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="colors is too large")
    # Written aside and renamed over, so a frame never reads half a file. The
    # dot keeps the temporary file out of the listing.
    temporary = sidecar.with_name(f".{sidecar.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        temporary.write_text('{"version":1,"colors":' + encoded + "}\n", encoding="utf-8")
        os.replace(temporary, sidecar)
    finally:
        _unlink_quietly(temporary)
    return entry_for(root, rel)


def candidate_names(name: str) -> Iterator[str]:
    """`name`, then `stem (2).ext`, `stem (3).ext`, ..."""
    yield name
    stem, extension = os.path.splitext(name)
    for number in range(2, 100000):
        yield f"{stem} ({number}){extension}"


def _free_rel(directory: Path, folder_rel: str, name: str) -> Iterator[tuple[str, Path]]:
    """Free (rel, disk path) candidates for `name` in `directory`."""
    for candidate in candidate_names(name):
        rel = join_path(folder_rel, candidate)
        if _path_problem(rel):
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {name} is taken")
        target = directory / candidate
        if not os.path.lexists(target):
            yield rel, target
    raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {name} is taken")


def ensure_folder(db: Session, project_id: int, root: Path, rel: str) -> Path:
    """Create `rel` and its parents. A file in the way is a 409. Share links
    left pointing at a path that did not exist (its folder was removed by
    hand) are dropped before the path exists again, so an old link never
    starts showing a new folder."""
    if rel == "":
        return root
    segments = rel.split("/")
    for depth in range(1, len(segments) + 1):
        current = "/".join(segments[:depth])
        target = disk_path(root, current)
        if target.is_dir():
            continue
        if os.path.lexists(target):
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"{current} is a file")
        delete_shares_at_or_below(db, project_id, current)
        try:
            target.mkdir()
        except FileExistsError:
            if not target.is_dir():
                raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"{current} is a file")
    return disk_path(root, rel)


def create_folder(db: Session, project_id: int, root: Path, rel: str) -> dict[str, Any]:
    target = disk_path(root, rel)
    if os.path.lexists(target):
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="That path exists")
    ensure_folder(db, project_id, root, rel)
    db.commit()
    return entry_for(root, rel)


def valid_upload_id(upload_id: str) -> bool:
    return bool(_UPLOAD_ID_RE.fullmatch(upload_id or ""))


def upload_part_path(project_id: int, upload_id: str) -> Path:
    return cache_dir() / "uploads" / f"project_{int(project_id)}-{upload_id}.part"


def cleanup_stale_parts(now: Optional[float] = None) -> None:
    current = now if now is not None else time.time()
    _unlink_older_than(cache_dir() / "uploads", current - UPLOAD_PART_MAX_AGE_SECONDS)
    # Thumbnails are keyed by the photo's path and stat, so a rename, move,
    # replace or delete leaves one behind for good. A month-old thumbnail is
    # made again on request; an orphan is gone.
    _THUMB_SWEEP.sweep(current)


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


class _ThumbSweep:
    """At most once an hour, across all projects."""

    def __init__(self) -> None:
        self.last = 0.0
        self.lock = threading.Lock()

    def sweep(self, now: float, force: bool = False) -> None:
        with self.lock:
            if not force and now - self.last < 3600:
                return
            self.last = now
        _unlink_older_than(cache_dir() / "thumbs", now - THUMB_MAX_AGE_SECONDS)


_THUMB_SWEEP = _ThumbSweep()


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


def finish_upload(
    db: Session, project_id: int, root: Path, folder_rel: str, filename: str, upload_id: str
) -> dict[str, Any]:
    """Move a finished part into `folder_rel` under a free name."""
    part = upload_part_path(project_id, upload_id)
    if not part.is_file():
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="chunk_gap")
    folder = ensure_folder(db, project_id, root, folder_rel)
    db.commit()
    for rel, target in _free_rel(folder, folder_rel, filename):
        # Claim the name first (O_EXCL), then move the bytes over the claim:
        # two uploads of one name never land on the same file.
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError:
            continue
        os.close(fd)
        try:
            try:
                os.replace(part, target)
            except FileNotFoundError:
                # A second complete=1 for the same upload: the first took the
                # part. The client starts over, as for any lost part.
                _unlink_quietly(target)
                raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="chunk_gap")
            except OSError:
                # Another filesystem (a separately mounted project folder).
                shutil.copyfile(part, target)
                _unlink_quietly(part)
        except OSError:
            _unlink_quietly(target)
            raise
        _carry_colors(None, target)
        return entry_for(root, rel)
    raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {filename} is taken")


def move_paths(db: Session, project_id: int, root: Path, paths: list[str], to: str) -> list[dict[str, str]]:
    """Move every path into the folder `to`. All of them are checked before
    anything moves."""
    destination = disk_path(root, to)
    if not destination.is_dir():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Destination folder not found")
    sources: dict[str, Path] = {}
    for path in paths:
        if path in sources:
            continue
        if is_at_or_below(to, path):
            raise HTTPException(
                status_code=HTTPStatus.BAD_REQUEST, detail="A folder cannot be moved into itself"
            )
        source = disk_path(root, path)
        if not os.path.lexists(source):
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"{path} not found")
        sources[path] = source

    moved: list[dict[str, str]] = []
    done: list[tuple[str, str]] = []
    for path, source in sources.items():
        # Already carried along with a folder moved earlier in this call.
        carried = next(((old, new) for old, new in done if path.startswith(old + "/")), None)
        if carried is not None:
            moved.append({"from": path, "to": carried[1] + path[len(carried[0]):]})
            continue
        if parent_path(path) == to:
            moved.append({"from": path, "to": path})
            continue
        new_rel, target = next(_free_rel(destination, to, base_name(path)))
        assert_subtree_fits(source, new_rel)
        delete_shares_at_or_below(db, project_id, new_rel)
        is_file = not source.is_dir()
        os.rename(source, target)
        if is_file:
            _carry_colors(source, target)
        rewrite_share_paths(db, project_id, path, new_rel)
        # Per item: a later failure must not take the links of what already
        # moved back to where it was.
        db.commit()
        done.append((path, new_rel))
        moved.append({"from": path, "to": new_rel})
    return moved


def rename_path(db: Session, project_id: int, root: Path, path: str, name: str) -> dict[str, Any]:
    source = disk_path(root, path)
    if not os.path.lexists(source):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    new_rel = validate_path(join_path(parent_path(path), name))
    if new_rel == path:
        return entry_for(root, path)
    assert_subtree_fits(source, new_rel)
    target = disk_path(root, new_rel)
    if os.path.lexists(target):
        # A case-only rename on a case-insensitive disk finds itself.
        try:
            same = os.path.samefile(source, target)
        except OSError:
            same = False
        if not same:
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=f"The name {name} is taken")
    else:
        delete_shares_at_or_below(db, project_id, new_rel)
    is_file = not source.is_dir()
    os.rename(source, target)
    if is_file:
        _carry_colors(source, target)
    rewrite_share_paths(db, project_id, path, new_rel)
    db.commit()
    return entry_for(root, new_rel)


def delete_paths(db: Session, project_id: int, root: Path, paths: list[str]) -> int:
    """Delete files and folders (with everything in them, and the share links
    at or below them). Paths that are already gone are skipped."""
    deleted = 0
    for path in dict.fromkeys(paths):
        target = root / path
        if not os.path.lexists(target):
            continue
        if not _inside(os.path.realpath(target.parent), os.path.realpath(root)):
            continue
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
            _unlink_quietly(colors_file(target))
        delete_shares_at_or_below(db, project_id, path)
        db.commit()
        deleted += 1
    return deleted


# ---------------------------------------------------------------------------
# Share links
# ---------------------------------------------------------------------------


def share_url(token: str) -> str:
    return f"{SHARE_URL_PREFIX}/{token}"


def share_json(share: PhotoShare) -> dict[str, Any]:
    created_at = share.created_at
    if created_at is not None and created_at.tzinfo is None:
        # Stored as naive UTC.
        created_at = created_at.replace(tzinfo=timezone.utc)
    return {
        "token": share.token,
        "path": share.path,
        "url": share_url(share.token),
        "created_at": int(created_at.timestamp()) if created_at is not None else None,
    }


def rewrite_share_paths(db: Session, project_id: int, old: str, new: str) -> None:
    """Links at or below a moved/renamed folder follow it."""
    for share in db.query(PhotoShare).filter(PhotoShare.project_id == project_id).all():
        if is_at_or_below(share.path, old):
            share.path = new + share.path[len(old):]


def delete_shares_at_or_below(db: Session, project_id: int, path: str) -> None:
    for share in db.query(PhotoShare).filter(PhotoShare.project_id == project_id).all():
        if is_at_or_below(share.path, path):
            db.delete(share)


def valid_share_token(token: str) -> bool:
    return bool(_SHARE_TOKEN_RE.fullmatch(token or ""))


@dataclass
class SharedPhoto:
    path: str  # relative to the shared folder
    name: str
    file: Path
    stat: os.stat_result
    has_colors: bool = False


@dataclass
class SharedFolder:
    name: str
    folder: Path
    boundary: str  # the shared folder, resolved


def shared_folder(share: PhotoShare) -> SharedFolder:
    """The folder a link points at, or 404 when it is gone."""
    if _path_problem(share.path or "") or not share.path:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    root = project_root(int(share.project_id))
    if not root.is_dir():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    folder = disk_path(root, share.path)
    if not folder.is_dir():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return SharedFolder(name=base_name(share.path), folder=folder, boundary=os.path.realpath(folder))


def share_index(shared: SharedFolder) -> tuple[list[SharedPhoto], int]:
    """Every playable file below the shared folder by path (at most
    MAX_SHARE_FILES), and when anything in it last changed."""
    photos: list[SharedPhoto] = []
    try:
        updated_at = int(shared.folder.stat().st_mtime)
    except OSError:
        updated_at = 0
    for child in walk(shared.folder, "", shared.boundary):
        if child.is_dir:
            updated_at = max(updated_at, int(child.stat.st_mtime))
            continue
        if not is_playable(child.name):
            continue
        updated_at = max(updated_at, int(child.stat.st_mtime))
        photos.append(
            SharedPhoto(path=child.rel, name=child.name, file=child.path, stat=child.stat, has_colors=child.has_colors)
        )
    photos.sort(key=lambda photo: path_key(photo.path))
    return photos[:MAX_SHARE_FILES], updated_at


def shared_photo_json(token: str, photo: SharedPhoto) -> dict[str, Any]:
    width, height = image_size(photo.file, photo.stat)
    return {
        "path": photo.path,
        "name": photo.name,
        "url": f"{share_url(token)}/file?path={quote(photo.path, safe='')}",
        "size": int(photo.stat.st_size),
        "mtime": int(photo.stat.st_mtime),
        "width": width,
        "height": height,
        "content_type": content_type_for(photo.name),
        "colors": read_colors(photo.file) if photo.has_colors else None,
    }


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
        return sorted(photos, key=lambda photo: (-photo.stat.st_mtime_ns, photo.path))[position]
    if order == "oldest":
        return sorted(photos, key=lambda photo: (photo.stat.st_mtime_ns, photo.path))[position]
    permutation = list(range(count))
    random.Random(f"{token}:{index // count}").shuffle(permutation)
    return photos[permutation[position]]


def shared_file(shared: SharedFolder, rel: str) -> Path:
    """A playable file below the shared folder, or 404."""
    if not is_playable(base_name(rel)):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    target = disk_path(shared.folder, rel, boundary=Path(shared.boundary))
    if not target.is_file():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Not found")
    return target
