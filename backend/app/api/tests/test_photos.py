"""Photos routes against docs/photos.md: the owner routes (project scoped)
and the share routes frames call without a login."""
from __future__ import annotations

import io
import os
from pathlib import Path
from urllib.parse import quote

import pytest
from PIL import Image

from app.models.photo_share import PhotoShare
from app.utils import photos as photos_utils


@pytest.fixture(autouse=True)
def photos_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "photos"
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(directory))
    monkeypatch.delenv("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL", raising=False)
    monkeypatch.delenv("HASSIO_TOKEN", raising=False)
    # CI may itself run in a container; the persistence check has tests of
    # its own below.
    monkeypatch.setattr(photos_utils, "_running_in_docker", lambda: False)
    return directory


def library(async_client) -> Path:
    root = Path(os.environ["FRAMEOS_PHOTOS_DIR"]) / f"project_{async_client.project_id}"
    root.mkdir(parents=True, exist_ok=True)
    return root


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


def write(root: Path, rel: str, data: bytes = b"x", mtime: float | None = None) -> Path:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    if mtime is not None:
        os.utime(target, (mtime, mtime))
    return target


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
        "location": str(photos_dir / f"project_{async_client.project_id}"),
        "used_bytes": 5,
        "quota_bytes": None,
        "free_bytes": body["free_bytes"],
        "max_upload_bytes": 64 * 1024 * 1024,
        "accepts": None,
        "client_thumbnails": False,
        "scanning": [],
    }
    assert isinstance(body["free_bytes"], int) and body["free_bytes"] > 0
    # The write probe leaves nothing behind.
    assert sorted(p.name for p in library(async_client).iterdir()) == ["Album"]


@pytest.mark.asyncio
async def test_a_folder_that_can_not_be_written_blocks_the_library(async_client, tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("a file where the photos folder should be")
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(blocker))

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
    library(async_client)
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
    }
    assert (library(async_client) / "Summer 2026/Beach/beach.jpg").read_bytes() == data
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
    assert not (library(async_client) / "a.jpg").exists()


@pytest.mark.asyncio
async def test_a_taken_name_gets_a_number(async_client):
    for index, expected in enumerate(["Album/a.jpg", "Album/a (2).jpg", "Album/a (3).jpg"]):
        response = await upload(async_client, "Album", "a.jpg", b"bytes %d" % index, upload_id=f"upload-{index:04d}")
        assert response.status_code == 200, response.text
        assert response.json()["entry"]["path"] == expected
    assert (library(async_client) / "Album/a (3).jpg").read_bytes() == b"bytes 2"
    assert (library(async_client) / "Album/a.jpg").read_bytes() == b"bytes 0"


@pytest.mark.asyncio
async def test_upload_limits(async_client, monkeypatch):
    monkeypatch.setattr(photos_utils, "MAX_UPLOAD_BYTES", 16)
    response = await upload(async_client, "", "a.jpg", b"x" * 10, complete=0)
    assert response.status_code == 200
    response = await upload(async_client, "", "a.jpg", b"x" * 10, offset=10, complete=1)
    assert response.status_code == 413
    assert not (library(async_client) / "a.jpg").exists()

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
    root = library(async_client)
    write(root, "Album 10/x.png", b"png")
    write(root, "album 2/sub/deep.jpg", jpeg_bytes())
    write(root, "album 2/notes.txt", b"hello")
    write(root, "album 2/.DS_Store", b"junk")
    write(root, "Covers/b.jpg", jpeg_bytes())
    write(root, "Covers/A.png", b"png-bytes")
    write(root, "img10.jpg", jpeg_bytes(10, 20))
    write(root, "img2.jpg", jpeg_bytes(30, 40))
    write(root, "B.txt", b"text")
    write(root, ".DS_Store", b"junk")
    write(root, ".hidden/secret.jpg", jpeg_bytes())

    response = await async_client.get("/api/photos/files", params={"path": ""})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["path"] == ""
    assert [entry["name"] for entry in body["entries"]] == [
        "album 2",
        "Album 10",
        "Covers",
        "B.txt",
        "img2.jpg",
        "img10.jpg",
    ]
    by_name = {entry["name"]: entry for entry in body["entries"]}
    album2 = by_name["album 2"]
    assert album2["kind"] == "folder"
    assert album2["items"] == 2  # notes.txt + sub, not .DS_Store
    assert album2["files"] == 2
    assert album2["size"] == len(b"hello") + len(jpeg_bytes())
    # No image among the direct children: the first one a level down.
    assert album2["cover"] == "album 2/sub/deep.jpg"
    assert album2["status"] == "ready"
    assert isinstance(album2["mtime"], int)
    # First image by name (case insensitive).
    assert by_name["Covers"]["cover"] == "Covers/A.png"
    assert by_name["Album 10"]["cover"] == "Album 10/x.png"

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
async def test_symlinks_out_of_the_library_are_not_there(async_client, tmp_path):
    root = library(async_client)
    outside = tmp_path / "outside"
    write(outside, "secret.jpg", jpeg_bytes())
    os.symlink(outside, root / "escape")
    os.symlink(outside / "secret.jpg", root / "escape.jpg")
    write(root, "Real/a.jpg", jpeg_bytes())
    os.symlink(root / "Real", root / "Alias")

    names = [entry["name"] for entry in (await async_client.get("/api/photos/files")).json()["entries"]]
    assert names == ["Alias", "Real"]
    assert (await async_client.get("/api/photos/files", params={"path": "escape"})).status_code == 404
    assert (await async_client.get("/api/photos/file", params={"path": "escape.jpg"})).status_code == 404
    assert (await async_client.get("/api/photos/file", params={"path": "escape/secret.jpg"})).status_code == 404
    assert (await async_client.get("/api/photos/file", params={"path": "Alias/a.jpg"})).status_code == 200


# ---------------------------------------------------------------------------
# Files and thumbnails
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_file_route_serves_inert_bytes(async_client):
    root = library(async_client)
    data = jpeg_bytes()
    write(root, "Album/a.jpg", data)
    write(root, "Album/page.html", b"<script>alert(1)</script>")
    write(root, "Album/notes.txt", b"hello")

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
    root = library(async_client)
    write(root, "big.jpg", jpeg_bytes(1200, 800))
    write(root, "turned.jpg", jpeg_bytes(1200, 800, orientation=6))
    write(root, "broken.jpg", b"nope")
    write(root, "notes.txt", b"hello")

    response = await async_client.get("/api/photos/thumb", params={"path": "big.jpg"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(response.content)) as thumb:
        assert thumb.size == (512, 341)
    etag = response.headers["etag"]

    # Cached: the same bytes, and a revalidation is a 304.
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

    # The backend makes its own thumbnails and ignores the browser's.
    response = await async_client.post(
        "/api/photos/thumb", params={"path": "big.jpg"}, content=b"jpeg", headers={"Content-Type": "image/jpeg"}
    )
    assert response.status_code == 204


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
    assert (library(async_client) / "Summer 2026/Beach").is_dir()

    response = await async_client.post("/api/photos/folders", json={"path": "Summer 2026/Beach"})
    assert response.status_code == 409
    response = await async_client.post("/api/photos/folders", json={"path": "Summer 2026"})
    assert response.status_code == 409

    write(library(async_client), "file.jpg", b"x")
    response = await async_client.post("/api/photos/folders", json={"path": "file.jpg/inside"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_move(async_client, db):
    root = library(async_client)
    write(root, "a.jpg", b"a")
    write(root, "Summer/b.jpg", b"b")
    write(root, "Summer/Beach/c.jpg", b"c")
    write(root, "Albums/2026/a.jpg", b"already here")
    write(root, "Albums/2026/stay.jpg", b"stay")
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
    assert (root / "Albums/2026/a (2).jpg").read_bytes() == b"a"
    assert (root / "Albums/2026/a.jpg").read_bytes() == b"already here"
    assert (root / "Albums/2026/Summer/Beach/c.jpg").read_bytes() == b"c"
    assert not (root / "Summer").exists()

    db.expire_all()
    paths = {row.token: row.path for row in db.query(PhotoShare).all()}
    assert paths == {summer["token"]: "Albums/2026/Summer", beach["token"]: "Albums/2026/Summer/Beach"}

    # Back to the root.
    response = await async_client.post("/api/photos/move", json={"paths": ["Albums/2026/Summer"], "to": ""})
    assert response.json() == {"moved": [{"from": "Albums/2026/Summer", "to": "Summer"}]}


@pytest.mark.asyncio
async def test_move_checks_everything_first(async_client):
    root = library(async_client)
    write(root, "a.jpg", b"a")
    write(root, "Summer/Beach/c.jpg", b"c")
    write(root, "Dest/keep.txt", b"k")

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg", "missing.jpg"], "to": "Dest"})
    assert response.status_code == 404
    assert (root / "a.jpg").exists()
    assert not (root / "Dest/a.jpg").exists()

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg", "Summer"], "to": "Summer"})
    assert response.status_code == 400
    response = await async_client.post("/api/photos/move", json={"paths": ["Summer"], "to": "Summer/Beach"})
    assert response.status_code == 400
    assert (root / "a.jpg").exists()

    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg"], "to": "Nowhere"})
    assert response.status_code == 404
    response = await async_client.post("/api/photos/move", json={"paths": ["a.jpg"], "to": "../x"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_rename(async_client, db):
    root = library(async_client)
    write(root, "Summer/a.jpg", jpeg_bytes())
    write(root, "Summer/b.jpg", b"b")
    write(root, "Summer/Beach/c.jpg", b"c")
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

    response = await async_client.post("/api/photos/rename", json={"path": "Summer", "name": "Summer 2026"})
    assert response.status_code == 200, response.text
    entry = response.json()["entry"]
    assert entry["kind"] == "folder" and entry["path"] == "Summer 2026"
    db.expire_all()
    paths = {row.token: row.path for row in db.query(PhotoShare).all()}
    assert paths == {summer["token"]: "Summer 2026", beach["token"]: "Summer 2026/Beach"}


@pytest.mark.asyncio
async def test_delete_removes_files_folders_and_their_links(async_client, db):
    root = library(async_client)
    write(root, "a.jpg", b"a")
    write(root, "Old album/Sub/b.jpg", b"b")
    write(root, "Other/c.jpg", b"c")
    await share(async_client, "Old album")
    await share(async_client, "Old album/Sub")
    other = await share(async_client, "Other")

    response = await async_client.post("/api/photos/delete", json={"paths": ["a.jpg", "Old album", "gone.jpg"]})

    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": 2}
    assert not (root / "a.jpg").exists()
    assert not (root / "Old album").exists()
    assert (root / "Other/c.jpg").exists()
    db.expire_all()
    assert [row.token for row in db.query(PhotoShare).all()] == [other["token"]]

    response = await async_client.post("/api/photos/delete", json={"paths": ["../Other"]})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_a_stale_link_does_not_follow_a_new_folder_of_the_same_name(async_client, db, no_auth_client):
    root = library(async_client)
    write(root, "Family/a.jpg", b"a")
    family = await share(async_client, "Family")
    # Removed by hand: the row stays, the link is a 404.
    import shutil

    shutil.rmtree(root / "Family")
    assert (await no_auth_client.get(f"/api/photos/shared/{family['token']}")).status_code == 404

    write(root, "Private/p.jpg", b"p")
    response = await async_client.post("/api/photos/rename", json={"path": "Private", "name": "Family"})
    assert response.status_code == 200
    assert (await no_auth_client.get(f"/api/photos/shared/{family['token']}")).status_code == 404


# ---------------------------------------------------------------------------
# Share links
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_share_links(async_client):
    root = library(async_client)
    write(root, "Summer 2026/a.jpg", b"a")
    write(root, "file.jpg", b"f")

    created = await share(async_client, "Summer 2026")
    assert created["path"] == "Summer 2026"
    assert created["token"].startswith("pk_") and len(created["token"]) >= 3 + 32
    assert created["url"] == f"/api/photos/shared/{created['token']}"
    assert isinstance(created["created_at"], int)
    # One link per folder.
    assert await share(async_client, "Summer 2026") == created

    assert (await async_client.post("/api/photos/shares", json={"path": ""})).status_code == 400
    assert (await async_client.post("/api/photos/shares", json={"path": "Nope"})).status_code == 404
    assert (await async_client.post("/api/photos/shares", json={"path": "file.jpg"})).status_code == 404
    assert (await async_client.post("/api/photos/shares", json={"path": "../x"})).status_code == 400

    response = await async_client.get("/api/photos/shares")
    assert response.json() == {"shares": [created]}

    response = await async_client.delete(f"/api/photos/shares/{created['token']}")
    assert response.json() == {"deleted": True}
    assert (await async_client.get("/api/photos/shares")).json() == {"shares": []}
    assert (await async_client.delete(f"/api/photos/shares/{created['token']}")).status_code == 404


@pytest.mark.asyncio
async def test_share_listing_without_a_login(async_client, no_auth_client, redis):
    root = library(async_client)
    write(root, "Summer 2026/b.jpg", jpeg_bytes(20, 10), mtime=1760000100)
    write(root, "Summer 2026/beach/a.jpg", jpeg_bytes(8, 6), mtime=1760000000)
    write(root, "Summer 2026/beach/notes.txt", b"not a photo")
    write(root, "Summer 2026/A.PNG", b"png", mtime=1760000050)
    write(root, "Summer 2026/.hidden.jpg", b"hidden")
    write(root, "Summer 2026/.cache/x.jpg", b"hidden")
    write(root, "Elsewhere/z.jpg", b"z")
    created = await share(async_client, "Summer 2026")
    token = created["token"]

    response = await no_auth_client.get(f"/api/photos/shared/{token}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Summer 2026"
    assert body["count"] == 3
    assert isinstance(body["updated_at"], int)
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
    }
    assert body["files"][0]["content_type"] == "image/png"


@pytest.mark.asyncio
async def test_share_photo_orders(async_client, no_auth_client, redis):
    root = library(async_client)
    # Path order: a, b, c, d; mtime order (oldest first): c, a, d, b.
    write(root, "Album/a.jpg", b"a", mtime=1760000100)
    write(root, "Album/b.jpg", b"b", mtime=1760000400)
    write(root, "Album/c.jpg", b"c", mtime=1760000000)
    write(root, "Album/sub/d.jpg", b"d", mtime=1760000200)
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
    root = library(async_client)
    write(root, "One/a.jpg", b"a")
    write(root, "Two/b.jpg", b"b")
    one = (await share(async_client, "One"))["token"]
    two = (await share(async_client, "Two"))["token"]

    await async_client.delete(f"/api/photos/shares/{one}")
    await async_client.post("/api/photos/delete", json={"paths": ["Two"]})

    for token in (one, two, "pk_" + "x" * 40, "nonsense"):
        for suffix in ("", "/photo", "/file?path=a.jpg"):
            response = await no_auth_client.get(f"/api/photos/shared/{token}{suffix}")
            assert response.status_code == 404, (token, suffix)


@pytest.mark.asyncio
async def test_shared_files(async_client, no_auth_client, tmp_path, redis):
    root = library(async_client)
    data = jpeg_bytes()
    write(root, "Album/sub/a b.jpg", data)
    write(root, "Album/notes.txt", b"not a photo")
    write(root, "Album/.secret.jpg", b"hidden")
    write(root, "Private/p.jpg", b"private")
    os.symlink(root / "Private", root / "Album/linked")
    os.symlink(root / "Private/p.jpg", root / "Album/p.jpg")
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
    assert "max-age" in response.headers["cache-control"]

    base = f"/api/photos/shared/{token}/file"
    assert (await no_auth_client.get(base, params={"path": "notes.txt"})).status_code == 404
    assert (await no_auth_client.get(base, params={"path": "missing.jpg"})).status_code == 404
    assert (await no_auth_client.get(base, params={"path": "linked/p.jpg"})).status_code == 404
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
