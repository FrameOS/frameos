"""Photos routes against docs/photos.md: the owner routes (project scoped)
and the share routes frames call without a login. The rows are
photo_entry; the bytes go to the object store under photos/<sha256>, a
directory here unless a test points the FRAMEOS_PHOTOS_S3_* variables at the
fake bucket below."""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import re
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from PIL import Image

from app.database import SessionLocal
from app.models import new_frame
from app.models.photo_entry import PhotoEntry
from app.models.photo_share import PhotoShare
from app.utils import photos as photos_utils
from app.utils.object_store import S3ObjectStore, is_valid_object_key, s3_settings_from_env
from app.utils.photo_album_scene import build_photo_album_scene

REPO_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture(autouse=True)
def photos_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "photos"
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(directory))
    for name in (
        "FRAMEOS_PHOTOS_ALLOW_EPHEMERAL",
        "HASSIO_TOKEN",
        "FRAMEOS_PHOTOS_S3_ENDPOINT",
        "FRAMEOS_PHOTOS_S3_BUCKET",
        "FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID",
        "FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY",
        "FRAMEOS_PHOTOS_S3_REGION",
        "FRAMEOS_PHOTOS_S3_PREFIX",
    ):
        monkeypatch.delenv(name, raising=False)
    # CI may itself run in a container; the persistence check has tests of
    # its own below.
    monkeypatch.setattr(photos_utils, "_running_in_docker", lambda: False)
    monkeypatch.setattr(photos_utils, "_STORE", None)
    photos_utils._READINESS_CACHE.clear()
    return directory


class Library:
    """The project's library: `write` stores a file the way an upload does."""

    def __init__(self, project_id: int) -> None:
        self.project_id = project_id


def library(async_client) -> Library:
    return Library(async_client.project_id)


def objects_root() -> Path:
    return Path(os.environ["FRAMEOS_PHOTOS_DIR"]) / "objects"


def object_file(data: bytes) -> Path:
    return objects_root() / "photos" / hashlib.sha256(data).hexdigest()


def thumb_file(data: bytes) -> Path:
    return objects_root() / "photos" / "thumbs" / hashlib.sha256(data).hexdigest()


def jpeg_bytes(width: int = 40, height: int = 30, color=(200, 10, 10), orientation: int | None = None) -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (width, height), color)
    if orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = orientation
        image.save(buffer, format="JPEG", exif=exif.tobytes())
    else:
        image.save(buffer, format="JPEG")
    return buffer.getvalue()


def write(lib: Library, rel: str, data: bytes = b"x", mtime: float | None = None) -> dict:
    """Store `data` at `rel` (folders on the way are made), as an upload would."""
    db = SessionLocal()
    try:
        store = photos_utils.ready_store()
        created = (
            datetime.datetime.fromtimestamp(mtime, tz=datetime.timezone.utc).replace(tzinfo=None)
            if mtime is not None
            else None
        )
        return photos_utils.store_file(
            db, lib.project_id, store, photos_utils.parent_path(rel), photos_utils.base_name(rel), data, created_at=created
        )
    finally:
        db.close()


def make_folder(lib: Library, rel: str) -> dict:
    db = SessionLocal()
    try:
        return photos_utils.create_folder(db, lib.project_id, rel)
    finally:
        db.close()


async def entry_of(client, path: str) -> dict | None:
    """The listing entry at `path`, or None."""
    parent = photos_utils.parent_path(path)
    response = await client.get("/api/photos/files", params={"path": parent})
    if response.status_code != 200:
        return None
    return next((entry for entry in response.json()["entries"] if entry["path"] == path), None)


async def read_file(client, path: str) -> bytes:
    response = await client.get("/api/photos/file", params={"path": path})
    assert response.status_code == 200, (path, response.text)
    return response.content


async def upload(client, folder: str, filename: str, data: bytes, upload_id: str = "upload-0001", **params):
    query = {"path": folder, "filename": filename, "upload_id": upload_id, "offset": 0, "complete": 1}
    query.update(params)
    return await client.post(
        "/api/photos/upload",
        params=query,
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )


async def share(client, path: str) -> dict:
    response = await client.post("/api/photos/shares", json={"path": path})
    assert response.status_code == 200, response.text
    return response.json()["share"]


# ---------------------------------------------------------------------------
# Auth and status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_routes_require_a_login(async_client, no_auth_client):
    project_id = async_client.project_id
    for method, path in (
        ("GET", "photos/status"),
        ("GET", "photos/files"),
        ("GET", "photos/shares"),
        ("POST", "photos/delete"),
    ):
        response = await no_auth_client.request(method, f"/api/projects/{project_id}/{path}", json={"paths": []})
        assert response.status_code == 401, (path, response.text)


@pytest.mark.asyncio
async def test_status_reports_a_ready_library(async_client, photos_dir):
    write(library(async_client), "Album/a.jpg", b"12345")

    response = await async_client.get("/api/photos/status")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "ready": True,
        "problem": None,
        "message": None,
        "location": str(photos_dir / "objects"),
        "used_bytes": 5,
        "quota_bytes": None,
        "free_bytes": body["free_bytes"],
        "max_upload_bytes": 250 * 1024 * 1024,
        "accepts": None,
        "scanning": [],
    }
    assert isinstance(body["free_bytes"], int) and body["free_bytes"] > 0
    # The write probe leaves nothing behind; the bytes are under their hash.
    assert sorted(p.name for p in (photos_dir / "objects").iterdir()) == ["photos"]
    assert object_file(b"12345").read_bytes() == b"12345"


@pytest.mark.asyncio
async def test_a_folder_that_can_not_be_written_blocks_the_library(async_client, tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("a file where the photos folder should be")
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(blocker))
    monkeypatch.setattr(photos_utils, "_STORE", None)

    response = await async_client.get("/api/photos/status")
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["problem"] == "not_writable"
    assert str(blocker) in body["message"]

    for method, path in (("GET", "/api/photos/files"), ("GET", "/api/photos/shares")):
        response = await async_client.request(method, path)
        assert response.status_code == 503, path
        assert response.json()["detail"] == body["message"]
    response = await async_client.post("/api/photos/folders", json={"path": "Album"})
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_a_folder_inside_the_container_is_not_persistent(async_client, photos_dir, monkeypatch):
    monkeypatch.setattr(photos_utils, "_running_in_docker", lambda: True)
    root_only = "22 1 0:21 / / rw,relatime - overlay overlay rw\n"
    monkeypatch.setattr(photos_utils, "_read_mountinfo", lambda: root_only)

    body = (await async_client.get("/api/photos/status")).json()
    assert body["ready"] is False
    assert body["problem"] == "not_persistent"
    assert "FRAMEOS_PHOTOS_ALLOW_EPHEMERAL" in body["message"]
    assert (await async_client.get("/api/photos/files")).status_code == 503

    monkeypatch.setenv("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL", "1")
    assert (await async_client.get("/api/photos/status")).json()["ready"] is True
    monkeypatch.delenv("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL")

    mounted = root_only + f"40 22 0:50 / {os.path.realpath(photos_dir)} rw,relatime - ext4 /dev/sda1 rw\n"
    monkeypatch.setattr(photos_utils, "_read_mountinfo", lambda: mounted)
    assert (await async_client.get("/api/photos/status")).json()["ready"] is True


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "../outside",
        "Album/../../outside",
        "/Album",
        "Album/",
        "Album//b",
        ".hidden",
        "Album/.DS_Store",
        ".",
        "a\\b",
        "a\x01b",
        "a\x7fb",
        "/".join(["d"] * 33),
        "x" * 256,
        "/".join(["y" * 200] * 6),
    ],
)
async def test_paths_that_break_the_rules_are_a_400(async_client, path):
    response = await async_client.get("/api/photos/files", params={"path": path})
    assert response.status_code == 400, response.text
    response = await async_client.post("/api/photos/folders", json={"path": path})
    assert response.status_code == 400, response.text


@pytest.mark.asyncio
async def test_the_deepest_and_longest_allowed_paths_work(async_client):
    deep = "/".join(["d"] * 32)
    response = await async_client.post("/api/photos/folders", json={"path": deep})
    assert response.status_code == 200, response.text
    long_name = "n" * 255
    response = await async_client.post("/api/photos/folders", json={"path": long_name})
    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_chunked_upload_lands_in_the_folder(async_client):
    data = jpeg_bytes(64, 48)
    first, second = data[:100], data[100:]

    response = await upload(async_client, "Summer 2026/Beach", "beach.jpg", first, complete=0)
    assert response.status_code == 200, response.text
    assert response.json() == {"pending": True, "received": 100}

    response = await upload(async_client, "Summer 2026/Beach", "beach.jpg", second, offset=100, complete=1)
    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert entry == {
        "path": "Summer 2026/Beach/beach.jpg",
        "name": "beach.jpg",
        "kind": "file",
        "size": len(data),
        "mtime": entry["mtime"],
        "content_type": "image/jpeg",
        "width": 64,
        "height": 48,
        "status": "ready",
        "colors": None,
    }
    assert await read_file(async_client, "Summer 2026/Beach/beach.jpg") == data
    # The bytes sit under their hash, with the thumbnail next to them.
    assert object_file(data).read_bytes() == data
    assert thumb_file(data).is_file()
    # The folders on the way exist as rows of their own.
    assert (await entry_of(async_client, "Summer 2026"))["kind"] == "folder"
    assert (await entry_of(async_client, "Summer 2026/Beach"))["files"] == 1
    # The part is gone.
    assert list((photos_utils.cache_dir() / "uploads").iterdir()) == []


@pytest.mark.asyncio
async def test_a_chunk_that_does_not_continue_the_upload_is_a_409(async_client):
    response = await upload(async_client, "", "a.jpg", b"0123456789", complete=0)
    assert response.json() == {"pending": True, "received": 10}

    # A gap.
    response = await upload(async_client, "", "a.jpg", b"abc", offset=20, complete=0)
    assert response.status_code == 409
    # A repeat of earlier bytes.
    response = await upload(async_client, "", "a.jpg", b"abc", offset=5, complete=0)
    assert response.status_code == 409
    # An id the server never saw (the part was dropped).
    response = await upload(async_client, "", "a.jpg", b"abc", upload_id="other-0001", offset=10, complete=1)
    assert response.status_code == 409
    assert await entry_of(async_client, "a.jpg") is None


@pytest.mark.asyncio
async def test_a_taken_name_gets_a_number(async_client):
    for index, expected in enumerate(["Album/a.jpg", "Album/a (2).jpg", "Album/a (3).jpg"]):
        response = await upload(async_client, "Album", "a.jpg", b"bytes %d" % index, upload_id=f"upload-{index:04d}")
        assert response.status_code == 200, response.text
        assert response.json()["entry"]["path"] == expected
    assert await read_file(async_client, "Album/a (3).jpg") == b"bytes 2"
    assert await read_file(async_client, "Album/a.jpg") == b"bytes 0"


@pytest.mark.asyncio
async def test_two_uploads_of_one_photo_share_one_object(async_client, db):
    data = jpeg_bytes(50, 40)
    assert (await upload(async_client, "A", "one.jpg", data, upload_id="upload-0001")).status_code == 200
    assert (await upload(async_client, "B", "two.jpg", data, upload_id="upload-0002")).status_code == 200
    rows = db.query(PhotoEntry).filter(PhotoEntry.kind == "file").all()
    assert len({row.object_key for row in rows}) == 1
    assert rows[0].object_key == f"photos/{hashlib.sha256(data).hexdigest()}"
    assert sorted(p.name for p in (objects_root() / "photos").iterdir()) == sorted([hashlib.sha256(data).hexdigest(), "thumbs"])
    assert len(list((objects_root() / "photos" / "thumbs").iterdir())) == 1

    # One row gone: the object stays for the other.
    assert (await async_client.post("/api/photos/delete", json={"paths": ["A/one.jpg"]})).json() == {"deleted": 1}
    assert object_file(data).is_file() and thumb_file(data).is_file()
    assert await read_file(async_client, "B/two.jpg") == data
    # The last row gone: the object and its thumbnail go too.
    assert (await async_client.post("/api/photos/delete", json={"paths": ["B"]})).json() == {"deleted": 1}
    assert not object_file(data).exists() and not thumb_file(data).exists()


@pytest.mark.asyncio
async def test_an_upload_loses_its_location_and_camera_metadata(async_client, db):
    """GPS, camera, XMP and what follows the image go before anything is
    stored; the turn stays (docs/photos.md "POST /api/photos/upload"). The
    object is named by the hash of what is left."""
    original = (REPO_ROOT / "docs" / "photo-metadata-fixtures" / "exif-gps.jpg").read_bytes()
    clean = photos_utils.without_private_metadata(original, "phone.jpg")
    assert clean != original and b"FixtureCam" not in clean
    response = await upload(async_client, "Trip", "phone.jpg", original)
    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert (entry["size"], entry["width"], entry["height"]) == (len(clean), 16, 24)
    assert await read_file(async_client, "Trip/phone.jpg") == clean
    row = db.query(PhotoEntry).filter(PhotoEntry.kind == "file").one()
    digest = hashlib.sha256(clean).hexdigest()
    assert (row.sha256, row.object_key, row.size_bytes) == (digest, f"photos/{digest}", len(clean))
    assert object_file(clean).is_file() and not object_file(original).exists()
    with Image.open(io.BytesIO(clean)) as image:
        assert image.getexif().get(0x0112) == 6
        assert not image.getexif().get_ifd(0x8825)

    # A file that is not a JPEG, PNG or WebP is stored as it came.
    assert (await upload(async_client, "Trip", "notes.txt", b"lat 59.43", upload_id="upload-0002")).status_code == 200
    assert await read_file(async_client, "Trip/notes.txt") == b"lat 59.43"


@pytest.mark.asyncio
async def test_upload_limits(async_client, monkeypatch):
    monkeypatch.setattr(photos_utils, "MAX_UPLOAD_BYTES", 16)
    response = await upload(async_client, "", "a.jpg", b"x" * 10, complete=0)
    assert response.status_code == 200
    response = await upload(async_client, "", "a.jpg", b"x" * 10, offset=10, complete=1)
    assert response.status_code == 413
    assert await entry_of(async_client, "a.jpg") is None

    monkeypatch.setattr(photos_utils, "MAX_CHUNK_BYTES", 8)
    response = await upload(async_client, "", "b.jpg", b"y" * 9)
    assert response.status_code == 413

    response = await upload(async_client, "", "b.jpg", b"y", upload_id="short")
    assert response.status_code == 400
    response = await upload(async_client, "", "b.jpg", b"y", upload_id="bad id with spaces")
    assert response.status_code == 400
    response = await upload(async_client, "", ".DS_Store", b"y")
    assert response.status_code == 400
    response = await upload(async_client, "../up", "b.jpg", b"y")
    assert response.status_code == 400
    response = await upload(async_client, "", "b.jpg", b"y", offset=-1)
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_an_upload_into_a_file_path_is_a_409(async_client):
    write(library(async_client), "taken", b"a file")
    response = await upload(async_client, "taken", "a.jpg", b"y")
    assert response.status_code == 409


def test_unfinished_uploads_are_dropped_after_an_hour(photos_dir):
    uploads = photos_utils.cache_dir() / "uploads"
    uploads.mkdir(parents=True)
    old = uploads / "project_1-old-upload.part"
    fresh = uploads / "project_1-new-upload.part"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    hour_ago = old.stat().st_mtime - 3601
    os.utime(old, (hour_ago, hour_ago))

    photos_utils.cleanup_stale_parts()

    assert not old.exists()
    assert fresh.exists()


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listing_shapes_and_order(async_client):
    lib = library(async_client)
    write(lib, "Album 10/x.png", b"png")
    write(lib, "album 2/sub/deep.jpg", jpeg_bytes())
    write(lib, "album 2/notes.txt", b"hello")
    write(lib, "Album 3/2026/October/first.jpg", jpeg_bytes())
    write(lib, "Album 3/2026/notes.txt", b"hello")
    write(lib, "Covers/b.jpg", jpeg_bytes())
    write(lib, "Covers/A.png", b"png-bytes")
    write(lib, "img10.jpg", jpeg_bytes(10, 20))
    write(lib, "img2.jpg", jpeg_bytes(30, 40))
    write(lib, "B.txt", b"text")
    make_folder(lib, "Empty")

    response = await async_client.get("/api/photos/files", params={"path": ""})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["path"] == ""
    assert [entry["name"] for entry in body["entries"]] == [
        "album 2",
        "Album 3",
        "Album 10",
        "Covers",
        "Empty",
        "B.txt",
        "img2.jpg",
        "img10.jpg",
    ]
    by_name = {entry["name"]: entry for entry in body["entries"]}
    album2 = by_name["album 2"]
    assert album2["kind"] == "folder"
    assert album2["items"] == 2  # notes.txt + sub
    assert album2["files"] == 2
    assert album2["size"] == len(b"hello") + len(jpeg_bytes())
    # No image among the direct children: the first one a level down.
    assert album2["cover"] == "album 2/sub/deep.jpg"
    assert album2["status"] == "ready"
    assert isinstance(album2["mtime"], int)
    # First image by name (case insensitive).
    assert by_name["Covers"]["cover"] == "Covers/A.png"
    assert by_name["Album 10"]["cover"] == "Album 10/x.png"
    # Photos only in a folder in a folder: the album still gets a cover.
    assert by_name["Album 3"]["cover"] == "Album 3/2026/October/first.jpg"
    assert by_name["Album 3"]["files"] == 2
    assert by_name["Empty"] == {
        "path": "Empty",
        "name": "Empty",
        "kind": "folder",
        "size": 0,
        "mtime": by_name["Empty"]["mtime"],
        "items": 0,
        "files": 0,
        "cover": None,
        "width": None,
        "height": None,
        "content_type": None,
        "status": "ready",
    }

    img2 = by_name["img2.jpg"]
    assert img2 == {
        "path": "img2.jpg",
        "name": "img2.jpg",
        "kind": "file",
        "size": len(jpeg_bytes(30, 40)),
        "mtime": img2["mtime"],
        "content_type": "image/jpeg",
        "width": 30,
        "height": 40,
        "status": "ready",
        "colors": None,
    }
    text = by_name["B.txt"]
    assert text["content_type"] == "text/plain"
    assert text["width"] is None and text["height"] is None

    response = await async_client.get("/api/photos/files", params={"path": "album 2"})
    assert [entry["path"] for entry in response.json()["entries"]] == ["album 2/sub", "album 2/notes.txt"]
    sub = response.json()["entries"][0]
    assert sub["cover"] == "album 2/sub/deep.jpg"


@pytest.mark.asyncio
async def test_listing_a_missing_folder_is_a_404(async_client):
    write(library(async_client), "a.jpg", jpeg_bytes())
    assert (await async_client.get("/api/photos/files", params={"path": "Nope"})).status_code == 404
    assert (await async_client.get("/api/photos/files", params={"path": "a.jpg"})).status_code == 404


@pytest.mark.asyncio
async def test_an_unreadable_image_lists_without_a_size(async_client):
    write(library(async_client), "broken.jpg", b"not really a jpeg")
    entry = (await async_client.get("/api/photos/files")).json()["entries"][0]
    assert entry["name"] == "broken.jpg"
    assert entry["width"] is None and entry["height"] is None


@pytest.mark.asyncio
async def test_exif_rotation_is_applied_to_the_size(async_client):
    write(library(async_client), "turned.jpg", jpeg_bytes(60, 20, orientation=6))
    entry = (await async_client.get("/api/photos/files")).json()["entries"][0]
    assert (entry["width"], entry["height"]) == (20, 60)


@pytest.mark.asyncio
async def test_libraries_of_two_projects_are_apart(async_client, db):
    lib = library(async_client)
    write(lib, "Mine/a.jpg", b"mine")
    other = Library(lib.project_id + 1000)
    db.add(PhotoEntry(project_id=other.project_id, path="Theirs", kind="folder", size_bytes=0, status="ready"))
    db.commit()
    names = [entry["name"] for entry in (await async_client.get("/api/photos/files")).json()["entries"]]
    assert names == ["Mine"]
    assert (await async_client.get("/api/photos/files", params={"path": "Theirs"})).status_code == 404


# ---------------------------------------------------------------------------
# Files and thumbnails
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_file_route_serves_inert_bytes(async_client):
    lib = library(async_client)
    data = jpeg_bytes()
    write(lib, "Album/a.jpg", data)
    write(lib, "Album/page.html", b"<script>alert(1)</script>")
    write(lib, "Album/notes.txt", b"hello")

    response = await async_client.get("/api/photos/file", params={"path": "Album/a.jpg"})
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    assert response.headers["content-disposition"].startswith("inline")

    response = await async_client.get("/api/photos/file", params={"path": "Album/a.jpg", "download": "1"})
    assert response.headers["content-disposition"].startswith("attachment")

    for name in ("page.html", "notes.txt"):
        response = await async_client.get("/api/photos/file", params={"path": f"Album/{name}"})
        assert response.status_code == 200
        assert response.headers["content-disposition"].startswith("attachment"), name

    assert (await async_client.get("/api/photos/file", params={"path": "Album"})).status_code == 404
    assert (await async_client.get("/api/photos/file", params={"path": "Album/none.jpg"})).status_code == 404


@pytest.mark.asyncio
async def test_thumbnails(async_client):
    lib = library(async_client)
    write(lib, "big.jpg", jpeg_bytes(1200, 800))
    write(lib, "turned.jpg", jpeg_bytes(1200, 800, orientation=6))
    write(lib, "broken.jpg", b"nope")
    write(lib, "notes.txt", b"hello")

    response = await async_client.get("/api/photos/thumb", params={"path": "big.jpg"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(response.content)) as thumb:
        assert thumb.size == (512, 341)
    etag = response.headers["etag"]

    # The same bytes again, and a revalidation is a 304.
    again = await async_client.get("/api/photos/thumb", params={"path": "big.jpg"})
    assert again.content == response.content
    not_modified = await async_client.get(
        "/api/photos/thumb", params={"path": "big.jpg"}, headers={"If-None-Match": etag}
    )
    assert not_modified.status_code == 304

    response = await async_client.get("/api/photos/thumb", params={"path": "turned.jpg"})
    with Image.open(io.BytesIO(response.content)) as thumb:
        assert thumb.size == (341, 512)

    for path in ("broken.jpg", "notes.txt", "missing.jpg"):
        response = await async_client.get("/api/photos/thumb", params={"path": path})
        assert response.status_code == 404, path

    # Each plane makes its own thumbnails: there is nothing to send one to.
    response = await async_client.post(
        "/api/photos/thumb", params={"path": "big.jpg"}, content=b"jpeg", headers={"Content-Type": "image/jpeg"}
    )
    assert response.status_code == 405


def test_a_huge_image_gets_no_thumbnail(monkeypatch):
    # Each format has its own cap: a JPEG is read through draft mode and may
    # be far larger than a PNG, which decodes whole.
    monkeypatch.setattr(photos_utils, "THUMB_MAX_PIXELS", 1000)
    monkeypatch.setattr(photos_utils, "THUMB_MAX_JPEG_PIXELS", 2000)
    assert photos_utils.thumbnail_of(jpeg_bytes(20, 20), "small.jpg") is not None
    assert photos_utils.thumbnail_of(jpeg_bytes(40, 40), "big.jpg") is not None
    assert photos_utils.thumbnail_of(jpeg_bytes(50, 50), "huge.jpg") is None

    def png_bytes(side: int) -> bytes:
        buffer = io.BytesIO()
        Image.new("RGB", (side, side), (10, 200, 10)).save(buffer, format="PNG")
        return buffer.getvalue()

    assert photos_utils.thumbnail_of(png_bytes(20), "small.png") is not None
    assert photos_utils.thumbnail_of(png_bytes(40), "big.png") is None


# ---------------------------------------------------------------------------
# Folders, move, rename, delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_folders(async_client):
    response = await async_client.post("/api/photos/folders", json={"path": "Summer 2026/Beach"})
    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert entry["path"] == "Summer 2026/Beach"
    assert entry["kind"] == "folder"
    assert entry["items"] == 0 and entry["files"] == 0 and entry["cover"] is None
    assert (await entry_of(async_client, "Summer 2026"))["items"] == 1

    response = await async_client.post("/api/photos/folders", json={"path": "Summer 2026/Beach"})
    assert response.status_code == 409
    response = await async_client.post("/api/photos/folders", json={"path": "Summer 2026"})
    assert response.status_code == 409

    write(library(async_client), "file.jpg", b"x")
    response = await async_client.post("/api/photos/folders", json={"path": "file.jpg/inside"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_move(async_client, db):
    lib = library(async_client)
    write(lib, "a.jpg", b"a")
    write(lib, "Summer/b.jpg", b"b")
    write(lib, "Summer/Beach/c.jpg", b"c")
    write(lib, "Albums/2026/a.jpg", b"already here")
    write(lib, "Albums/2026/stay.jpg", b"stay")
    summer = await share(async_client, "Summer")
    beach = await share(async_client, "Summer/Beach")

    response = await async_client.post(
        "/api/photos/move",
        json={"paths": ["a.jpg", "Summer", "Albums/2026/stay.jpg"], "to": "Albums/2026"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "moved": [
            {"from": "a.jpg", "to": "Albums/2026/a (2).jpg"},
            {"from": "Summer", "to": "Albums/2026/Summer"},
            {"from": "Albums/2026/stay.jpg", "to": "Albums/2026/stay.jpg"},
        ]
    }
    assert await read_file(async_client, "Albums/2026/a (2).jpg") == b"a"
    assert await read_file(async_client, "Albums/2026/a.jpg") == b"already here"
    assert await read_file(async_client, "Albums/2026/Summer/Beach/c.jpg") == b"c"
    assert await entry_of(async_client, "Summer") is None

    db.expire_all()
    paths = {row.token: row.path for row in db.query(PhotoShare).all()}
    assert paths == {summer["token"]: "Albums/2026/Summer", beach["token"]: "Albums/2026/Summer/Beach"}

    # Back to the root.
    response = await async_client.post("/api/photos/move", json={"paths": ["Albums/2026/Summer"], "to": ""})
    assert response.json() == {"moved": [{"from": "Albums/2026/Summer", "to": "Summer"}]}
    assert await read_file(async_client, "Summer/Beach/c.jpg") == b"c"


@pytest.mark.asyncio
async def test_a_path_inside_a_moved_folder_is_reported_too(async_client):
    lib = library(async_client)
    write(lib, "Summer/Beach/c.jpg", b"c")
    make_folder(lib, "Dest")
    response = await async_client.post(
        "/api/photos/move", json={"paths": ["Summer/Beach/c.jpg", "Summer"], "to": "Dest"}
    )
    assert response.json() == {
        "moved": [
            {"from": "Summer/Beach/c.jpg", "to": "Dest/Summer/Beach/c.jpg"},
            {"from": "Summer", "to": "Dest/Summer"},
        ]
    }


@pytest.mark.asyncio
async def test_move_checks_everything_first(async_client):
    lib = library(async_client)
    write(lib, "a.jpg", b"a")
    write(lib, "Summer/Beach/c.jpg", b"c")
    write(lib, "Dest/keep.txt", b"k")

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg", "missing.jpg"], "to": "Dest"})
    assert response.status_code == 404
    assert await entry_of(async_client, "a.jpg") is not None
    assert await entry_of(async_client, "Dest/a.jpg") is None

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg", "Summer"], "to": "Summer"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/move", json={"paths": ["Summer"], "to": "Summer/Beach"})
    assert response.status_code == 400
    assert await entry_of(async_client, "a.jpg") is not None

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg"], "to": "Nowhere"})
    assert response.status_code == 404
    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg"], "to": "Dest/keep.txt"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg"], "to": "../x"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/move", json={"paths": [], "to": "Dest"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/delete", json={"paths": []})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_a_folder_cannot_be_moved_where_its_contents_would_not_fit(async_client):
    lib = library(async_client)
    deep = "/".join(["d"] * 30)
    write(lib, f"Top/{deep}/leaf.jpg", b"x")
    write(lib, "Dest/keep.txt", b"k")
    # Top/d/.../leaf.jpg is 32 deep already; one more folder is one too many.
    response = await async_client.post("/api/photos/move", json={"paths": ["Top"], "to": "Dest"})
    assert response.status_code == 400
    assert (await entry_of(async_client, "Top"))["kind"] == "folder"
    assert await entry_of(async_client, "Dest/Top") is None
    response = await async_client.post("/api/photos/rename", json={"path": "Top", "name": "x" * 1010})
    assert response.status_code == 400
    assert await entry_of(async_client, "Top") is not None
    # A rename that keeps everything within reach still works.
    response = await async_client.post("/api/photos/rename", json={"path": "Top", "name": "Tip"})
    assert response.status_code == 200
    assert (await entry_of(async_client, f"Tip/{deep}/leaf.jpg"))["kind"] == "file"


@pytest.mark.asyncio
async def test_rename(async_client, db):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())
    write(lib, "Summer/b.jpg", b"b")
    write(lib, "Summer/Beach/c.jpg", b"c")
    summer = await share(async_client, "Summer")
    beach = await share(async_client, "Summer/Beach")

    response = await async_client.post("/api/photos/rename", json={"path": "Summer/a.jpg", "name": "first.jpg"})
    assert response.status_code == 200, response.text
    assert response.json()["entry"]["path"] == "Summer/first.jpg"
    assert response.json()["entry"]["width"] == 40

    response = await async_client.post("/api/photos/rename", json={"path": "Summer/first.jpg", "name": "b.jpg"})
    assert response.status_code == 409
    response = await async_client.post("/api/photos/rename", json={"path": "Summer/none.jpg", "name": "x.jpg"})
    assert response.status_code == 404
    response = await async_client.post("/api/photos/rename", json={"path": "Summer/b.jpg", "name": "../x.jpg"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/rename", json={"path": "Summer/b.jpg", "name": ".x.jpg"})
    assert response.status_code == 400
    # A rename to the same name is a no-op.
    response = await async_client.post("/api/photos/rename", json={"path": "Summer/b.jpg", "name": "b.jpg"})
    assert response.status_code == 200

    response = await async_client.post("/api/photos/rename", json={"path": "Summer", "name": "Summer 2026"})
    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert entry["kind"] == "folder" and entry["path"] == "Summer 2026"
    assert await read_file(async_client, "Summer 2026/Beach/c.jpg") == b"c"
    db.expire_all()
    paths = {row.token: row.path for row in db.query(PhotoShare).all()}
    assert paths == {summer["token"]: "Summer 2026", beach["token"]: "Summer 2026/Beach"}


@pytest.mark.asyncio
async def test_a_moved_folder_does_not_take_its_namesakes_along(async_client):
    """`Summer` and `Summer 2` share a prefix, not a folder."""
    lib = library(async_client)
    write(lib, "Summer/a.jpg", b"a")
    write(lib, "Summer 2/b.jpg", b"b")
    write(lib, "Summer%/c.jpg", b"c")
    make_folder(lib, "Dest")
    response = await async_client.post("/api/photos/move", json={"paths": ["Summer"], "to": "Dest"})
    assert response.status_code == 200, response.text
    names = [entry["name"] for entry in (await async_client.get("/api/photos/files")).json()["entries"]]
    assert names == ["Dest", "Summer 2", "Summer%"]
    assert await read_file(async_client, "Summer 2/b.jpg") == b"b"


@pytest.mark.asyncio
async def test_delete_removes_files_folders_and_their_links(async_client, db):
    lib = library(async_client)
    write(lib, "a.jpg", b"a")
    write(lib, "Old album/Sub/b.jpg", b"b")
    write(lib, "Other/c.jpg", b"c")
    await share(async_client, "Old album")
    await share(async_client, "Old album/Sub")
    other = await share(async_client, "Other")

    response = await async_client.post("/api/photos/delete", json={"paths": ["a.jpg", "Old album", "gone.jpg"]})

    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": 2}
    assert await entry_of(async_client, "a.jpg") is None
    assert await entry_of(async_client, "Old album") is None
    assert await entry_of(async_client, "Other/c.jpg") is not None
    assert not object_file(b"a").exists() and not object_file(b"b").exists()
    assert object_file(b"c").exists()
    db.expire_all()
    assert [row.token for row in db.query(PhotoShare).all()] == [other["token"]]

    response = await async_client.post("/api/photos/delete", json={"paths": ["../Other"]})
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Share links
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_share_links(async_client):
    lib = library(async_client)
    write(lib, "Summer 2026/a.jpg", b"a")
    write(lib, "file.jpg", b"f")

    created = await share(async_client, "Summer 2026")
    assert created["path"] == "Summer 2026"
    assert created["token"].startswith("pk_") and len(created["token"]) >= 3 + 32
    assert created["url"] == f"/api/photos/shared/{created['token']}"
    assert isinstance(created["created_at"], int)
    # One link per folder.
    assert await share(async_client, "Summer 2026") == created

    assert (await async_client.post("/api/photos/shares", json={"path": ""})).status_code == 400
    assert (await async_client.post("/api/photos/shares", json={"path": "Nope"})).status_code == 404
    # A file is a 400, as on the cloud; only a missing path is a 404.
    assert (await async_client.post("/api/photos/shares", json={"path": "file.jpg"})).status_code == 400
    assert (await async_client.post("/api/photos/shares", json={"path": "../x"})).status_code == 400

    response = await async_client.get("/api/photos/shares")
    assert response.json() == {"shares": [created]}

    response = await async_client.delete(f"/api/photos/shares/{created['token']}")
    assert response.json() == {"deleted": True}
    assert (await async_client.get("/api/photos/shares")).json() == {"shares": []}
    assert (await async_client.delete(f"/api/photos/shares/{created['token']}")).status_code == 404


@pytest.mark.asyncio
async def test_share_links_per_frame(async_client, db, redis):
    """A folder has one general link and one per frame, each deletable alone."""
    lib = library(async_client)
    write(lib, "Summer 2026/a.jpg", b"a")
    kitchen = await new_frame(db, redis, "Kitchen", "localhost", "10.0.0.5")
    hall = await new_frame(db, redis, "Hall", "localhost", "10.0.0.6")

    general = await share(async_client, "Summer 2026")
    assert general["frame_id"] is None
    for_kitchen = (await async_client.post(
        "/api/photos/shares", json={"path": "Summer 2026", "frame_id": kitchen.id}
    )).json()["share"]
    assert for_kitchen["frame_id"] == kitchen.id
    assert for_kitchen["token"] != general["token"]
    # One link per frame and folder; the general link is not it.
    again = (await async_client.post(
        "/api/photos/shares", json={"path": "Summer 2026", "frame_id": kitchen.id}
    )).json()["share"]
    assert again == for_kitchen
    assert await share(async_client, "Summer 2026") == general
    for_hall = (await async_client.post(
        "/api/photos/shares", json={"path": "Summer 2026", "frame_id": hall.id}
    )).json()["share"]
    assert len({general["token"], for_kitchen["token"], for_hall["token"]}) == 3

    listed = (await async_client.get("/api/photos/shares")).json()["shares"]
    assert [row["frame_id"] for row in listed] == [None, kitchen.id, hall.id]

    assert (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "frame_id": 999999})).status_code == 404
    assert (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "frame_id": "7"})).status_code == 400
    assert (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "frame_id": True})).status_code == 400

    # Withdrawing the kitchen's link leaves the others playing.
    assert (await async_client.delete(f"/api/photos/shares/{for_kitchen['token']}")).json() == {"deleted": True}
    assert [row["token"] for row in (await async_client.get("/api/photos/shares")).json()["shares"]] == [
        general["token"], for_hall["token"],
    ]


@pytest.mark.asyncio
async def test_custom_share_links_and_last_use(async_client, no_auth_client, redis):
    """A named link is a new one every time, and every link says when it was last read."""
    write(library(async_client), "Summer 2026/a.jpg", b"a")
    grandma = (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "name": " Grandma "})).json()["share"]
    assert grandma["name"] == "Grandma" and grandma["frame_id"] is None and grandma["last_used_at"] is None
    again = (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "name": "Grandma"})).json()["share"]
    assert again["token"] != grandma["token"]
    general = await share(async_client, "Summer 2026")
    assert general["name"] is None and general["token"] not in (grandma["token"], again["token"])
    for bad in ("", "   ", "x" * 121, 7, True):
        assert (await async_client.post("/api/photos/shares", json={"path": "Summer 2026", "name": bad})).status_code == 400

    assert (await no_auth_client.get(f"/api/photos/shared/{grandma['token']}")).status_code == 200
    listed = {row["token"]: row for row in (await async_client.get("/api/photos/shares")).json()["shares"]}
    assert isinstance(listed[grandma["token"]]["last_used_at"], int)
    assert listed[again["token"]]["last_used_at"] is None
    assert listed[general["token"]]["last_used_at"] is None


@pytest.mark.asyncio
async def test_share_listing_without_a_login(async_client, no_auth_client, redis):
    lib = library(async_client)
    write(lib, "Summer 2026/b.jpg", jpeg_bytes(20, 10), mtime=1760000100)
    write(lib, "Summer 2026/beach/a.jpg", jpeg_bytes(8, 6), mtime=1760000000)
    write(lib, "Summer 2026/beach/notes.txt", b"not a photo")
    write(lib, "Summer 2026/A.PNG", b"png", mtime=1760000050)
    write(lib, "Elsewhere/z.jpg", b"z")
    created = await share(async_client, "Summer 2026")
    token = created["token"]

    response = await no_auth_client.get(f"/api/photos/shared/{token}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Summer 2026"
    assert body["count"] == 3
    assert isinstance(body["updated_at"], int) and body["updated_at"] > 1760000100
    assert [photo["path"] for photo in body["files"]] == ["A.PNG", "b.jpg", "beach/a.jpg"]
    beach = body["files"][2]
    assert beach == {
        "path": "beach/a.jpg",
        "name": "a.jpg",
        "url": f"/api/photos/shared/{token}/file?path=beach%2Fa.jpg",
        "size": len(jpeg_bytes(8, 6)),
        "mtime": 1760000000,
        "width": 8,
        "height": 6,
        "content_type": "image/jpeg",
        "colors": None,
    }
    assert body["files"][0]["content_type"] == "image/png"


@pytest.mark.asyncio
async def test_share_listing_is_in_natural_order_like_the_cloud(async_client, no_auth_client, redis):
    lib = library(async_client)
    for name in ("IMG_10.jpg", "IMG_2.jpg", "img_1.jpg", "b/IMG_3.jpg", "a.jpg"):
        write(lib, f"Album/{name}", b"x")
    token = (await share(async_client, "Album"))["token"]
    body = (await no_auth_client.get(f"/api/photos/shared/{token}")).json()
    assert [photo["path"] for photo in body["files"]] == ["a.jpg", "b/IMG_3.jpg", "img_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]


@pytest.mark.asyncio
async def test_share_photo_orders(async_client, no_auth_client, redis):
    lib = library(async_client)
    # Path order: a, b, c, d; mtime order (oldest first): c, a, d, b.
    write(lib, "Album/a.jpg", b"a", mtime=1760000100)
    write(lib, "Album/b.jpg", b"b", mtime=1760000400)
    write(lib, "Album/c.jpg", b"c", mtime=1760000000)
    write(lib, "Album/sub/d.jpg", b"d", mtime=1760000200)
    token = (await share(async_client, "Album"))["token"]

    async def pick(order: str | None, index: int | None) -> dict:
        params: dict = {}
        if order is not None:
            params["order"] = order
        if index is not None:
            params["index"] = index
        response = await no_auth_client.get(f"/api/photos/shared/{token}/photo", params=params)
        assert response.status_code == 200, response.text
        return response.json()

    sequential = [(await pick("sequential", index))["photo"]["path"] for index in range(6)]
    assert sequential == ["a.jpg", "b.jpg", "c.jpg", "sub/d.jpg", "a.jpg", "b.jpg"]
    newest = [(await pick("newest", index))["photo"]["path"] for index in range(4)]
    assert newest == ["b.jpg", "sub/d.jpg", "a.jpg", "c.jpg"]
    oldest = [(await pick("oldest", index))["photo"]["path"] for index in range(4)]
    assert oldest == ["c.jpg", "a.jpg", "sub/d.jpg", "b.jpg"]

    body = await pick("sequential", 41)
    assert body["index"] == 41 and body["count"] == 4
    assert body["photo"]["url"] == f"/api/photos/shared/{token}/file?path=b.jpg"

    # Random is the default: every photo once per cycle, the same answer for
    # the same index.
    cycles = []
    for cycle in range(5):
        shown = [(await pick(None, cycle * 4 + offset))["photo"]["path"] for offset in range(4)]
        assert sorted(shown) == ["a.jpg", "b.jpg", "c.jpg", "sub/d.jpg"]
        cycles.append(shown)
    assert (await pick("random", 6))["photo"]["path"] == cycles[1][2]
    assert len({tuple(order) for order in cycles}) > 1

    response = await no_auth_client.get(f"/api/photos/shared/{token}/photo", params={"order": "shuffle"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_an_empty_album(async_client, no_auth_client, redis):
    write(library(async_client), "Empty/readme.txt", b"no photos here")
    token = (await share(async_client, "Empty"))["token"]

    response = await no_auth_client.get(f"/api/photos/shared/{token}/photo", params={"index": 3})
    assert response.json() == {"index": 3, "count": 0, "photo": None}
    response = await no_auth_client.get(f"/api/photos/shared/{token}")
    assert response.json()["files"] == [] and response.json()["count"] == 0


@pytest.mark.asyncio
async def test_a_deleted_link_or_folder_is_a_404(async_client, no_auth_client, redis):
    lib = library(async_client)
    write(lib, "One/a.jpg", b"a")
    write(lib, "Two/b.jpg", b"b")
    one = (await share(async_client, "One"))["token"]
    two = (await share(async_client, "Two"))["token"]

    await async_client.delete(f"/api/photos/shares/{one}")
    await async_client.post("/api/photos/delete", json={"paths": ["Two"]})

    for token in (one, two, "pk_" + "x" * 40, "nonsense"):
        for suffix in ("", "/photo", "/file?path=a.jpg"):
            response = await no_auth_client.get(f"/api/photos/shared/{token}{suffix}")
            assert response.status_code == 404, (token, suffix)


@pytest.mark.asyncio
async def test_shared_files(async_client, no_auth_client, redis):
    lib = library(async_client)
    data = jpeg_bytes()
    write(lib, "Album/sub/a b.jpg", data)
    write(lib, "Album/notes.txt", b"not a photo")
    write(lib, "Private/p.jpg", b"private")
    token = (await share(async_client, "Album"))["token"]

    listing = (await no_auth_client.get(f"/api/photos/shared/{token}")).json()
    assert [photo["path"] for photo in listing["files"]] == ["sub/a b.jpg"]

    url = listing["files"][0]["url"]
    assert url == f"/api/photos/shared/{token}/file?path={quote('sub/a b.jpg', safe='')}"
    response = await no_auth_client.get(url)
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "private, max-age=300"

    base = f"/api/photos/shared/{token}/file"
    assert (await no_auth_client.get(base, params={"path": "notes.txt"})).status_code == 404
    assert (await no_auth_client.get(base, params={"path": "missing.jpg"})).status_code == 404
    # Another folder's photo is not below the shared one.
    assert (await no_auth_client.get(base, params={"path": "p.jpg"})).status_code == 404
    assert (await no_auth_client.get(base, params={"path": "../Private/p.jpg"})).status_code == 400
    assert (await no_auth_client.get(base, params={"path": ".secret.jpg"})).status_code == 400
    assert (await no_auth_client.get(base, params={"path": "/etc/passwd.jpg"})).status_code == 400
    assert (await no_auth_client.get(base, params={"path": ""})).status_code == 400


@pytest.mark.asyncio
async def test_share_routes_are_rate_limited_per_address(async_client, no_auth_client, monkeypatch, redis):
    from app.api import photos as photos_api

    write(library(async_client), "Album/a.jpg", b"a")
    token = (await share(async_client, "Album"))["token"]
    monkeypatch.setattr(photos_api, "SHARE_REQUESTS_PER_HOUR", 2)

    assert (await no_auth_client.get(f"/api/photos/shared/{token}")).status_code == 200
    assert (await no_auth_client.get(f"/api/photos/shared/{token}/photo")).status_code == 200
    assert (await no_auth_client.get(f"/api/photos/shared/{token}/file?path=a.jpg")).status_code == 429


# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------


async def set_colors(client, path: str, colors):
    return await client.post("/api/photos/colors", json={"path": path, "colors": colors})


@pytest.mark.asyncio
async def test_colors_are_a_column_of_the_photo(async_client, db):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())
    profile = {"whites": -30, "hues": {"blue": {"saturation": 20}}, "palette": ["#000000", "#ffffff"]}

    response = await set_colors(async_client, "Summer/a.jpg", profile)

    assert response.status_code == 200, response.text
    assert response.json()["entry"]["colors"] == profile
    db.expire_all()
    assert db.query(PhotoEntry).filter(PhotoEntry.path == "Summer/a.jpg").one().colors == profile
    listing = (await async_client.get("/api/photos/files", params={"path": "Summer"})).json()
    assert listing["entries"][0]["colors"] == profile
    album = (await async_client.get("/api/photos/files", params={"path": ""})).json()["entries"][0]
    assert album["files"] == 1 and album["items"] == 1
    assert album["size"] == len(jpeg_bytes())
    assert "colors" not in album

    for empty in (None, {}):
        await set_colors(async_client, "Summer/a.jpg", profile)
        response = await set_colors(async_client, "Summer/a.jpg", empty)
        assert response.status_code == 200, response.text
        assert response.json()["entry"]["colors"] is None


@pytest.mark.asyncio
async def test_colors_refuse_what_the_contract_refuses(async_client):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())
    write(lib, "Summer/notes.txt", b"text")

    assert (await set_colors(async_client, "Summer/a.jpg", [1, 2])).status_code == 400
    assert (await set_colors(async_client, "Summer/a.jpg", "bright")).status_code == 400
    assert (await set_colors(async_client, "Summer/notes.txt", {"whites": 1})).status_code == 400
    assert (await set_colors(async_client, "Summer", {"whites": 1})).status_code == 400
    assert (await set_colors(async_client, "Summer/missing.jpg", {"whites": 1})).status_code == 404
    # The key is required: a request that forgot it must not clear a profile.
    assert (await async_client.post("/api/photos/colors", json={"path": "Summer/a.jpg"})).status_code == 400
    assert (await set_colors(async_client, "../a.jpg", {"whites": 1})).status_code == 400
    big = {"note": "x" * (64 * 1024)}
    assert (await set_colors(async_client, "Summer/a.jpg", big)).status_code == 413
    assert (await entry_of(async_client, "Summer/a.jpg"))["colors"] is None


@pytest.mark.asyncio
async def test_colors_travel_with_the_photo(async_client):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())
    make_folder(lib, "Winter")
    await set_colors(async_client, "Summer/a.jpg", {"exposure": 0.5})

    response = await async_client.post("/api/photos/rename", json={"path": "Summer/a.jpg", "name": "b.jpg"})
    assert response.json()["entry"]["colors"] == {"exposure": 0.5}

    response = await async_client.post("/api/photos/move", json={"paths": ["Summer/b.jpg"], "to": "Winter"})
    assert response.status_code == 200, response.text
    moved = (await async_client.get("/api/photos/files", params={"path": "Winter"})).json()["entries"]
    assert moved[0]["colors"] == {"exposure": 0.5}

    response = await async_client.post("/api/photos/move", json={"paths": ["Winter"], "to": "Summer"})
    assert response.status_code == 200, response.text
    assert (await entry_of(async_client, "Summer/Winter/b.jpg"))["colors"] == {"exposure": 0.5}

    # The same bytes uploaded again are a new photo without a profile.
    response = await upload(async_client, "Summer", "again.jpg", jpeg_bytes())
    assert response.json()["entry"]["colors"] is None


@pytest.mark.asyncio
async def test_names_ending_in_frameos_json_are_kept_for_colors(async_client):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())

    response = await upload(async_client, "Summer", "x.frameos.json", b"{}")
    assert response.status_code == 400, response.text
    response = await async_client.post(
        "/api/photos/rename", json={"path": "Summer/a.jpg", "name": "a.jpg.FrameOS.json"}
    )
    assert response.status_code == 400
    response = await async_client.post("/api/photos/folders", json={"path": "Summer/x.frameos.json"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_share_routes_carry_the_colors(async_client, no_auth_client, redis):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes())
    write(lib, "Summer/b.jpg", jpeg_bytes(10, 10))
    await set_colors(async_client, "Summer/a.jpg", {"whites": -30})
    token = (await share(async_client, "Summer"))["token"]

    listing = (await no_auth_client.get(f"/api/photos/shared/{token}")).json()
    assert {photo["path"]: photo["colors"] for photo in listing["files"]} == {"a.jpg": {"whites": -30}, "b.jpg": None}
    assert listing["count"] == 2

    base = f"/api/photos/shared/{token}/photo"
    picked = (await no_auth_client.get(base, params={"order": "sequential"})).json()
    assert picked["photo"]["path"] == "a.jpg"
    assert picked["photo"]["colors"] == {"whites": -30}
    picked = (await no_auth_client.get(base, params={"order": "sequential", "index": 1})).json()
    assert picked["photo"]["colors"] is None
    response = await no_auth_client.get(f"/api/photos/shared/{token}/file", params={"path": "a.jpg.frameos.json"})
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# An S3-compatible bucket (FRAMEOS_PHOTOS_S3_*)
# ---------------------------------------------------------------------------


class FakeBucket:
    """An S3 bucket behind httpx.MockTransport: path-style requests, SigV4
    headers checked for shape, and the objects it holds."""

    def __init__(self, bucket: str = "frame-photos") -> None:
        self.bucket = bucket
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.requests: list[httpx.Request] = []
        self.refuse: int | None = None

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.refuse is not None:
            return httpx.Response(self.refuse, text="refused")
        authorization = request.headers.get("authorization", "")
        scope = re.search(r"Credential=AKIATEST/\d{8}/auto/s3/aws4_request", authorization)
        assert scope, authorization
        assert "SignedHeaders=" in authorization and re.search(r"Signature=[0-9a-f]{64}$", authorization)
        assert request.headers["x-amz-content-sha256"] == hashlib.sha256(request.content).hexdigest()
        assert re.fullmatch(r"\d{8}T\d{6}Z", request.headers["x-amz-date"])
        prefix = f"/{self.bucket}/"
        assert request.url.path.startswith(prefix), request.url.path
        key = request.url.path[len(prefix):]
        if request.method == "PUT":
            self.objects[key] = (request.content, request.headers.get("content-type", ""))
            return httpx.Response(200)
        if request.method == "HEAD":
            return httpx.Response(200 if key in self.objects else 404)
        if request.method == "GET":
            if key not in self.objects:
                return httpx.Response(404, text="<Error><Code>NoSuchKey</Code></Error>")
            data, content_type = self.objects[key]
            return httpx.Response(200, content=data, headers={"content-type": content_type})
        if request.method == "DELETE":
            self.objects.pop(key, None)
            return httpx.Response(204)
        return httpx.Response(405)


@pytest.fixture
def bucket(monkeypatch) -> FakeBucket:
    fake = FakeBucket()
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_BUCKET", fake.bucket)
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID", "AKIATEST")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_PREFIX", "frameos/")

    def build(settings):
        return S3ObjectStore(settings, client=httpx.Client(transport=fake.transport()))

    monkeypatch.setattr(photos_utils, "S3ObjectStore", build)
    monkeypatch.setattr(photos_utils, "_STORE", None)
    photos_utils._READINESS_CACHE.clear()
    return fake


def test_s3_settings_come_from_the_environment(monkeypatch):
    assert s3_settings_from_env() == (None, None)
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ENDPOINT", "account.r2.cloudflarestorage.com")
    settings, problem = s3_settings_from_env()
    assert settings is None and "FRAMEOS_PHOTOS_S3_BUCKET" in problem and "ACCESS_KEY_ID" in problem
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_BUCKET", "photos")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY", "s")
    settings, problem = s3_settings_from_env()
    assert problem is None
    assert settings.endpoint == "https://account.r2.cloudflarestorage.com"
    assert settings.region == "auto" and settings.prefix == ""
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ENDPOINT", "https://s3.eu-central-1.amazonaws.com/photos")
    assert "service address" in s3_settings_from_env()[1]
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ENDPOINT", "https://s3.eu-central-1.amazonaws.com")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_REGION", "eu-central-1")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_PREFIX", "/one/two/")
    settings, _ = s3_settings_from_env()
    assert settings.region == "eu-central-1" and settings.prefix == "one/two"
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_BUCKET", "Not A Bucket")
    assert "bucket name" in s3_settings_from_env()[1]


def test_object_keys_are_checked():
    assert is_valid_object_key("photos/" + "a" * 64)
    assert is_valid_object_key("photos/thumbs/abc.jpg")
    for bad in ("", "/photos/x", "photos/../x", "photos//x", ".hidden", "photos/x\n", "x" * 600):
        assert not is_valid_object_key(bad), bad


@pytest.mark.asyncio
async def test_a_half_configured_bucket_blocks_the_library(async_client, monkeypatch):
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("FRAMEOS_PHOTOS_S3_BUCKET", "photos")
    body = (await async_client.get("/api/photos/status")).json()
    assert body["ready"] is False
    assert body["problem"] == "storage_misconfigured"
    assert "FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID" in body["message"]
    assert (await async_client.get("/api/photos/files")).status_code == 503


@pytest.mark.asyncio
async def test_a_bucket_that_refuses_the_keys_blocks_the_library(async_client, bucket):
    bucket.refuse = 403
    body = (await async_client.get("/api/photos/status")).json()
    assert body["ready"] is False
    assert body["problem"] == "storage_unavailable"
    assert "credentials" in body["message"]
    assert body["location"] == "s3://frame-photos/frameos at account.r2.cloudflarestorage.com"
    assert (await async_client.get("/api/photos/files")).status_code == 503


@pytest.mark.asyncio
async def test_photos_in_a_bucket(async_client, no_auth_client, db, bucket, photos_dir, redis):
    data = jpeg_bytes(1200, 800)
    digest = hashlib.sha256(data).hexdigest()

    status = (await async_client.get("/api/photos/status")).json()
    assert status["ready"] is True
    assert status["location"] == "s3://frame-photos/frameos at account.r2.cloudflarestorage.com"
    assert status["free_bytes"] is None

    response = await upload(async_client, "Summer", "a.jpg", data)
    assert response.status_code == 200, response.text
    assert response.json()["entry"]["width"] == 1200
    # The file and its thumbnail, under the prefix and their hash; nothing on
    # the disk but the finished upload's leftovers.
    assert set(bucket.objects) == {f"frameos/photos/{digest}", f"frameos/photos/thumbs/{digest}"}
    assert bucket.objects[f"frameos/photos/{digest}"] == (data, "image/jpeg")
    assert not (photos_dir / "objects").exists()
    assert status["used_bytes"] == 0 and (await async_client.get("/api/photos/status")).json()["used_bytes"] == len(data)

    # Served through the backend, from the bucket.
    assert await read_file(async_client, "Summer/a.jpg") == data
    thumb = await async_client.get("/api/photos/thumb", params={"path": "Summer/a.jpg"})
    assert thumb.status_code == 200 and thumb.headers["etag"] == f'"{digest}"'
    with Image.open(io.BytesIO(thumb.content)) as image:
        assert image.size == (512, 341)
    token = (await share(async_client, "Summer"))["token"]
    shared = await no_auth_client.get(f"/api/photos/shared/{token}/file", params={"path": "a.jpg"})
    assert shared.status_code == 200 and shared.content == data

    # A second copy shares the objects; deleting the last row deletes them.
    assert (await upload(async_client, "Winter", "b.jpg", data, upload_id="upload-0002")).status_code == 200
    assert len(bucket.objects) == 2
    assert (await async_client.post("/api/photos/delete", json={"paths": ["Summer"]})).json() == {"deleted": 1}
    assert len(bucket.objects) == 2
    assert (await async_client.post("/api/photos/delete", json={"paths": ["Winter/b.jpg"]})).json() == {"deleted": 1}
    assert bucket.objects == {}
    assert db.query(PhotoEntry).filter(PhotoEntry.kind == "file").count() == 0


@pytest.mark.asyncio
async def test_a_bucket_that_fails_mid_way_stores_nothing(async_client, bucket):
    # The bucket answered the readiness probe; it fails on the upload itself.
    assert (await async_client.get("/api/photos/files")).status_code == 200
    bucket.refuse = 500
    response = await upload(async_client, "Summer", "a.jpg", jpeg_bytes())
    assert response.status_code == 503
    assert "could not be stored" in response.json()["detail"]
    assert bucket.objects == {}
    bucket.refuse = None
    assert await entry_of(async_client, "Summer/a.jpg") is None


# ---------------------------------------------------------------------------
# Album scenes (POST /api/photos/scene, docs/photo-album-scene.json)
# ---------------------------------------------------------------------------


def normalized_album_scene(scene: dict) -> dict:
    """docs/photo-album-scene.json's normalization: ids out, refs in."""
    refs = {node["id"]: f"{node['type']}:{node['data']['keyword']}" for node in scene["nodes"]}
    app = scene["apps"]["photoAlbum"]
    return {
        "name": scene["name"],
        "settings": scene["settings"],
        "fields": scene["fields"],
        "nodes": [
            {"ref": refs[node["id"]], "type": node["type"], "data": node["data"], "position": node["position"]}
            for node in scene["nodes"]
        ],
        "edges": [
            {
                "source": refs[edge["source"]],
                "sourceHandle": edge["sourceHandle"],
                "target": refs[edge["target"]],
                "targetHandle": edge["targetHandle"],
                "type": edge["type"],
            }
            for edge in scene["edges"]
        ],
        "apps": {"photoAlbum": {"origin": app["origin"], "keys": sorted(app), "files": sorted(app["sources"])}},
    }


def test_album_scene_matches_the_fixture():
    fixture = json.loads((REPO_ROOT / "docs" / "photo-album-scene.json").read_text())
    given = fixture["input"]
    scene = build_photo_album_scene(
        name=given["name"],
        album_url=given["albumUrl"],
        seconds=given["seconds"],
        order=given["order"],
        fit=given["fit"],
        shapes=given["shapes"],
    )
    assert normalized_album_scene(scene) == fixture["scene"]
    # Exactly as the SPA writes it, numbers included.
    assert json.dumps(scene["settings"]["refreshInterval"]) == "600"
    ids = [scene["id"], *(node["id"] for node in scene["nodes"]), *(edge["id"] for edge in scene["edges"])]
    assert len(set(ids)) == len(ids)
    app_dir = REPO_ROOT / "repo" / "apps" / "image" / "photoAlbum"
    assert scene["apps"]["photoAlbum"]["sources"] == {
        name: (app_dir / name).read_text() for name in fixture["scene"]["apps"]["photoAlbum"]["files"]
    }
    # Each scene gets its own copy of the app.
    again = build_photo_album_scene(name="x", album_url="y", seconds=1.5, order="random", fit="cover")
    again["apps"]["photoAlbum"]["sources"]["app.ts"] = ""
    assert scene["apps"]["photoAlbum"]["sources"]["app.ts"]
    assert again["fields"][0]["value"] == "1.5"


@pytest.mark.asyncio
async def test_album_scene_route(async_client, no_auth_client, db, redis):
    write(library(async_client), "Summer 2026/a.jpg", jpeg_bytes())
    frame = await new_frame(db, redis, "Kitchen", "localhost", "10.0.0.5")
    frame.server_port = 8989
    frame.server_scheme = "http"
    db.commit()

    response = await async_client.post(
        "/api/photos/scene",
        json={
            "path": "Summer 2026",
            "frame_id": frame.id,
            "seconds": 600,
            "order": "newest",
            "fit": "contain",
            "shapes": ["square", "landscape"],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    token = body["share"]["token"]
    assert body["share"]["path"] == "Summer 2026"
    assert body["share"]["url"] == f"/api/photos/shared/{token}"
    scene = body["scene"]
    normalized = normalized_album_scene(scene)
    album = next(node for node in normalized["nodes"] if node["ref"] == "app:photoAlbum")
    assert album["data"]["config"] == {
        "album": f"http://10.0.0.5:8989/api/photos/shared/{token}",
        "counterStateKey": "photoIndex",
    }
    assert scene["name"] == "Summer 2026"
    assert scene["settings"]["refreshInterval"] == 600
    assert [field["value"] for field in scene["fields"]] == ["600", "newest", "contain", "true", "false", "true", "0"]
    # The link the scene carries plays.
    assert (await no_auth_client.get(f"/api/photos/shared/{token}")).json()["count"] == 1

    # The link is the frame's own, kept across installs; the folder's
    # general link is another one. Defaults and a name of one's own.
    assert body["share"]["frame_id"] == frame.id
    again = (await async_client.post(
        "/api/photos/scene", json={"path": "Summer 2026", "frame_id": frame.id, "name": " Beach "}
    )).json()
    assert again["share"]["token"] == token
    assert (await share(async_client, "Summer 2026"))["token"] != token
    assert db.query(PhotoShare).count() == 2
    assert again["scene"]["name"] == "Beach"
    assert again["scene"]["settings"]["refreshInterval"] == 3600
    assert [field["value"] for field in again["scene"]["fields"]] == ["3600", "random", "cover", "true", "true", "true", "0"]
    assert again["scene"]["id"] != scene["id"]

    # The address is the frame's: https and an IPv6 literal.
    frame.server_host = "fd00::5"
    frame.server_scheme = "https"
    frame.server_port = 8443
    db.commit()
    ipv6 = (await async_client.post("/api/photos/scene", json={"path": "Summer 2026", "frame_id": frame.id})).json()
    album_node = next(node for node in ipv6["scene"]["nodes"] if node["data"]["keyword"] == "photoAlbum")
    assert album_node["data"]["config"]["album"] == f"https://[fd00::5]:8443/api/photos/shared/{token}"


@pytest.mark.asyncio
async def test_album_scene_route_refusals(async_client, db, redis):
    write(library(async_client), "Summer/a.jpg", jpeg_bytes())
    frame = await new_frame(db, redis, "Kitchen", "localhost", "10.0.0.5")

    async def post(**body):
        return await async_client.post("/api/photos/scene", json={"path": "Summer", "frame_id": frame.id, **body})

    for bad in (
        {"seconds": 0},
        {"seconds": -5},
        {"seconds": "60"},
        {"seconds": True},
        {"order": "upside-down"},
        {"order": ["random"]},
        {"fit": "stretch"},
        {"shapes": []},
        {"shapes": ["round"]},
        {"shapes": "landscape"},
        {"shapes": ["landscape", "landscape"]},
        {"name": 5},
        {"name": "x" * 257},
        {"frame_id": None},
        {"frame_id": str(frame.id)},
        {"path": ""},
        {"path": "../etc"},
        {"path": "Summer/a.jpg"},
    ):
        response = await post(**bad)
        assert response.status_code == 400, (bad, response.text)
    assert (await post(frame_id=frame.id + 1000)).status_code == 404
    assert (await post(path="Nope")).status_code == 404
    # Nothing was shared by the refusals.
    assert db.query(PhotoShare).count() == 0

    frame.server_host = ""
    db.commit()
    response = await post()
    assert response.status_code == 400
    assert "address" in response.json()["detail"]
    assert db.query(PhotoShare).count() == 0


# ---------------------------------------------------------------------------
# Resize
# ---------------------------------------------------------------------------


async def resize(client, path: str, **options):
    return await client.post("/api/photos/resize", json={"path": path, **options})


def image_size(data: bytes) -> tuple[str, int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return (image.format or "").lower(), image.size[0], image.size[1]


@pytest.mark.asyncio
async def test_resize_replaces_the_bytes_and_keeps_the_row(async_client, db):
    lib = library(async_client)
    original = jpeg_bytes(400, 300)
    write(lib, "Summer/a.jpg", original, mtime=1_700_000_000)
    await set_colors(async_client, "Summer/a.jpg", {"whites": -10})

    response = await resize(async_client, "Summer/a.jpg", width=200, height=200)

    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert entry["path"] == "Summer/a.jpg"
    assert (entry["width"], entry["height"]) == (200, 150)
    assert entry["colors"] == {"whites": -10}
    assert entry["mtime"] == 1_700_000_000
    data = await read_file(async_client, "Summer/a.jpg")
    assert image_size(data) == ("jpeg", 200, 150)
    assert entry["size"] == len(data)
    # The old object is gone, the new one and its thumbnail are there.
    assert not object_file(original).exists()
    assert object_file(data).exists() and thumb_file(data).exists()
    thumb = await async_client.get("/api/photos/thumb", params={"path": "Summer/a.jpg"})
    assert thumb.status_code == 200 and image_size(thumb.content)[1:] == (200, 150)


@pytest.mark.asyncio
async def test_resize_fits_and_formats(async_client):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes(400, 300))

    # inside without upscale leaves a smaller photo alone; with it, it grows.
    response = await resize(async_client, "Summer/a.jpg", width=800, height=800)
    assert (response.json()["entry"]["width"], response.json()["entry"]["height"]) == (400, 300)
    response = await resize(async_client, "Summer/a.jpg", width=800, height=800, upscale=True)
    assert (response.json()["entry"]["width"], response.json()["entry"]["height"]) == (800, 600)

    # cover crops to the box; contain pads to it; fill stretches.
    response = await resize(async_client, "Summer/a.jpg", width=100, height=100, fit="cover")
    assert (response.json()["entry"]["width"], response.json()["entry"]["height"]) == (100, 100)
    write(lib, "Summer/b.jpg", jpeg_bytes(400, 300))
    response = await resize(async_client, "Summer/b.jpg", width=100, height=100, fit="contain", background="#000000")
    assert (response.json()["entry"]["width"], response.json()["entry"]["height"]) == (100, 100)
    with Image.open(io.BytesIO(await read_file(async_client, "Summer/b.jpg"))) as image:
        assert image.getpixel((50, 2))[0] < 20  # the pad is black
        assert image.getpixel((50, 50))[0] > 150  # the photo is red
    write(lib, "Summer/c.jpg", jpeg_bytes(400, 300))
    response = await resize(async_client, "Summer/c.jpg", width=100, height=100, fit="fill")
    assert (response.json()["entry"]["width"], response.json()["entry"]["height"]) == (100, 100)

    # A format change changes the extension, and the name stays free of clashes.
    write(lib, "Summer/d.jpg", jpeg_bytes(40, 30))
    write(lib, "Summer/d.png", jpeg_bytes(40, 30))
    response = await resize(async_client, "Summer/d.jpg", width=20, format="png", colors=16)
    assert response.status_code == 200, response.text
    assert response.json()["entry"]["path"] == "Summer/d (2).png"
    assert response.json()["entry"]["content_type"] == "image/png"
    assert image_size(await read_file(async_client, "Summer/d (2).png")) == ("png", 20, 15)
    response = await resize(async_client, "Summer/d (2).png", width=10, format="webp", quality=70)
    assert response.json()["entry"]["path"] == "Summer/d (2).webp"
    assert image_size(await read_file(async_client, "Summer/d (2).webp")) == ("webp", 10, 8)


@pytest.mark.asyncio
async def test_resize_refuses_what_the_contract_refuses(async_client):
    lib = library(async_client)
    write(lib, "Summer/a.jpg", jpeg_bytes(40, 30))
    write(lib, "Summer/notes.txt", b"hello")
    make_folder(lib, "Empty")

    for body, status in (
        ({"path": "Summer/a.jpg"}, 400),
        ({"path": "Summer/a.jpg", "width": 0}, 400),
        ({"path": "Summer/a.jpg", "width": 20, "fit": "cover"}, 400),
        ({"path": "Summer/a.jpg", "width": 20, "fit": "sideways"}, 400),
        ({"path": "Summer/a.jpg", "width": 20, "format": "tiff"}, 400),
        ({"path": "Summer/a.jpg", "width": 20, "quality": 0}, 400),
        ({"path": "Summer/a.jpg", "width": 20, "background": "red"}, 400),
        ({"path": "Summer/notes.txt", "width": 20}, 400),
        ({"path": "Empty", "width": 20}, 404),
        ({"path": "Summer/missing.jpg", "width": 20}, 404),
    ):
        response = await async_client.post("/api/photos/resize", json=body)
        assert response.status_code == status, (body, response.text)


@pytest.mark.asyncio
async def test_a_shared_photo_by_shape(async_client, no_auth_client, redis):
    """`shapes=`: only landscape, portrait or square photos count."""
    lib = library(async_client)
    write(lib, "Summer/l.jpg", jpeg_bytes(40, 30))
    write(lib, "Summer/p.jpg", jpeg_bytes(30, 40))
    write(lib, "Summer/s.jpg", jpeg_bytes(30, 30))
    link = await share(async_client, "Summer")

    async def pick(shapes: str, index: int = 0) -> dict:
        response = await no_auth_client.get(
            f"/api/photos/shared/{link['token']}/photo",
            params={"order": "sequential", "index": index, "shapes": shapes},
        )
        assert response.status_code == 200, response.text
        return response.json()

    assert (await pick("portrait"))["count"] == 1
    assert (await pick("portrait"))["photo"]["path"] == "p.jpg"
    assert (await pick("portrait", 7))["photo"]["path"] == "p.jpg"
    both = await pick("square, landscape")
    assert both["count"] == 2 and both["photo"]["path"] == "l.jpg"
    assert (await pick("square,landscape", 1))["photo"]["path"] == "s.jpg"
    # Empty, or every shape: every photo.
    assert (await pick(""))["count"] == 3
    assert (await pick("landscape,portrait,square"))["count"] == 3
    response = await no_auth_client.get(
        f"/api/photos/shared/{link['token']}/photo", params={"shapes": "landscape,round"}
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_a_shared_photo_by_path(async_client, no_auth_client, redis):
    lib = library(async_client)
    write(lib, "Summer/beach/a.jpg", jpeg_bytes())
    write(lib, "Summer/b.jpg", jpeg_bytes())
    link = await share(async_client, "Summer")

    response = await no_auth_client.get(f"/api/photos/shared/{link['token']}/photo", params={"path": "beach/a.jpg"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["index"], body["count"]) == (0, 1)
    assert body["photo"]["path"] == "beach/a.jpg"
    assert body["photo"]["url"].endswith("/file?path=beach%2Fa.jpg")

    for missing in ("beach/nope.jpg", "../b.jpg", "beach"):
        response = await no_auth_client.get(f"/api/photos/shared/{link['token']}/photo", params={"path": missing})
        assert response.status_code == 404, missing
