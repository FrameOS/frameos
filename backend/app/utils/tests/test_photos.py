"""The disk side of Photos (app/utils/photos.py): where the library lives,
the path rules, the persistence check and the share pick."""
from __future__ import annotations

import datetime

import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.photo_entry import PhotoEntry
from app.utils import photos


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ("FRAMEOS_PHOTOS_DIR", "FRAMEOS_PHOTOS_ALLOW_EPHEMERAL", "HASSIO_TOKEN", "DATABASE_URL"):
        monkeypatch.delenv(key, raising=False)


def test_photos_dir_resolution(monkeypatch, tmp_path):
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(tmp_path / "mine"))
    assert photos.photos_dir() == tmp_path / "mine"
    assert photos.objects_dir() == tmp_path / "mine" / "objects"
    assert photos.cache_dir() == tmp_path / "mine" / ".cache"
    monkeypatch.delenv("FRAMEOS_PHOTOS_DIR")

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/db/frameos.db")
    assert photos.photos_dir() == tmp_path / "db" / "photos"

    monkeypatch.setenv("DATABASE_URL", "sqlite:///../db/frameos.db")
    assert photos.photos_dir() == Path(os.path.abspath("../db/photos"))

    monkeypatch.setenv("DATABASE_URL", "postgresql://frameos@localhost/frameos")
    assert photos.photos_dir() == Path(os.path.abspath("../db/photos"))

    real_isdir = os.path.isdir
    monkeypatch.setattr(os.path, "isdir", lambda path: path == "/data" or real_isdir(path))
    monkeypatch.setenv("HASSIO_TOKEN", "token")
    assert photos.photos_dir() == Path("/data/photos")
    monkeypatch.setenv("FRAMEOS_PHOTOS_DIR", str(tmp_path / "mine"))
    assert photos.photos_dir() == tmp_path / "mine"


@pytest.mark.parametrize(
    "path",
    [
        "Summer 2026",
        "Summer 2026/beach.jpg",
        "a/b/c",
        "ünïcödé/фото.jpg",
        "/".join(["d"] * 32),
        "n" * 255,
        "/".join(["y" * 127] * 8) + "z",  # 1024 bytes
        "a..b",
        "trailing dot.",
    ],
)
def test_valid_paths(path):
    assert photos.validate_path(path) == path


@pytest.mark.parametrize(
    "path",
    [
        "/Summer",
        "Summer/",
        "a//b",
        ".",
        "..",
        "a/../b",
        "a/./b",
        ".hidden",
        "a/.DS_Store",
        "a\\b",
        "a\x00b",
        "a\nb",
        "a\x1fb",
        "a\x7fb",
        "/".join(["d"] * 33),
        "n" * 256,
        "é" * 128,  # 256 bytes
        "/".join(["y" * 127] * 8) + "zz",  # 1025 bytes
        "bad\udcffsurrogate",
    ],
)
def test_invalid_paths_are_a_400(path):
    with pytest.raises(HTTPException) as caught:
        photos.validate_path(path)
    assert caught.value.status_code == 400


def test_the_root():
    assert photos.validate_path("", allow_root=True) == ""
    assert photos.validate_path(None, allow_root=True) == ""
    with pytest.raises(HTTPException):
        photos.validate_path("")


def test_names():
    assert photos.validate_name("b.jpg") == "b.jpg"
    for name in ("", ".x", "a/b", "..", "x" * 256):
        with pytest.raises(HTTPException):
            photos.validate_name(name)


def test_natural_order():
    names = ["img10.jpg", "IMG2.jpg", "img1.jpg", "b", "A", "a", "Album 10", "album 2"]
    assert sorted(names, key=photos.natural_key) == [
        "A",
        "a",
        "album 2",
        "Album 10",
        "b",
        "img1.jpg",
        "IMG2.jpg",
        "img10.jpg",
    ]


def test_candidate_names():
    names = photos.candidate_names("beach.jpg")
    assert [next(names) for _ in range(3)] == ["beach.jpg", "beach (2).jpg", "beach (3).jpg"]
    names = photos.candidate_names("Album")
    assert [next(names) for _ in range(2)] == ["Album", "Album (2)"]


def test_playable_and_content_types():
    for name in ("a.jpg", "a.JPEG", "a.png", "a.gif", "a.bmp", "a.webp", "a.qoi", "a.ppm"):
        assert photos.is_playable(name), name
        assert photos.content_type_for(name).startswith("image/"), name
    for name in ("a.svg", "a.heic", "a.txt", "jpg", "a.jpg.txt"):
        assert not photos.is_playable(name), name
    assert photos.content_type_for("a.qoi") == "image/qoi"
    assert photos.content_type_for("a.unknownext") == "application/octet-stream"


MOUNTINFO = """\
22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/x
23 22 0:22 / /proc rw,nosuid - proc proc rw
30 22 8:1 /docker/volumes/db/_data /app/db rw,relatime - ext4 /dev/sda1 rw
31 22 8:1 /docker/containers/abc/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw
32 22 8:1 /photos /srv/my\\040photos rw,relatime - ext4 /dev/sda1 rw
"""


def test_mount_point_of():
    assert photos.mount_point_of("/app/db/photos/project_1", MOUNTINFO) == "/app/db"
    assert photos.mount_point_of("/app/db", MOUNTINFO) == "/app/db"
    assert photos.mount_point_of("/app/dbx/photos", MOUNTINFO) == "/"
    assert photos.mount_point_of("/app/photos", MOUNTINFO) == "/"
    assert photos.mount_point_of("/srv/my photos/project_1", MOUNTINFO) == "/srv/my photos"
    assert photos.mount_point_of("/x", "") is None


def test_photos_are_ephemeral_only_in_docker_off_a_volume(monkeypatch):
    on_volume = Path("/app/db/photos/project_1")
    in_container = Path("/app/photos/project_1")

    assert photos.photos_are_ephemeral(in_container, mountinfo=MOUNTINFO, in_docker=True) is True
    assert photos.photos_are_ephemeral(on_volume, mountinfo=MOUNTINFO, in_docker=True) is False
    assert photos.photos_are_ephemeral(in_container, mountinfo=MOUNTINFO, in_docker=False) is False
    # Mounts that cannot be read claim nothing.
    monkeypatch.setattr(photos, "_read_mountinfo", lambda: None)
    assert photos.photos_are_ephemeral(in_container, in_docker=True) is False

    monkeypatch.setenv("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL", "1")
    assert photos.photos_are_ephemeral(in_container, mountinfo=MOUNTINFO, in_docker=True) is False
    monkeypatch.delenv("FRAMEOS_PHOTOS_ALLOW_EPHEMERAL")

    monkeypatch.setenv("HASSIO_TOKEN", "token")
    assert photos.photos_are_ephemeral(in_container, mountinfo=MOUNTINFO, in_docker=True) is False


def _photos(tmp_path: Path, names: list[str]) -> list[photos.SharedPhoto]:
    found = []
    for index, name in enumerate(names):
        row = PhotoEntry(project_id=1, path=name, kind="file", size_bytes=1, created_at=datetime.datetime(2026, 1, 1, 0, 0, index))
        found.append(photos.SharedPhoto(path=name, name=name, row=row))
    return found


def test_random_pick_shows_every_photo_once_per_cycle(tmp_path):
    names = [f"{index:02d}.jpg" for index in range(17)]
    album = _photos(tmp_path, names)
    token = "pk_" + "a" * 40

    orders = []
    for cycle in range(4):
        shown = [photos.pick_photo(album, "random", cycle * 17 + i, token).path for i in range(17)]  # type: ignore[union-attr]
        assert sorted(shown) == names
        orders.append(shown)
    assert len({tuple(order) for order in orders}) == 4
    # Deterministic: the same token and index give the same photo.
    assert photos.pick_photo(album, "random", 20, token).path == orders[1][3]  # type: ignore[union-attr]
    # Another link shuffles differently.
    other = [photos.pick_photo(album, "random", i, "pk_" + "b" * 40).path for i in range(17)]  # type: ignore[union-attr]
    assert other != orders[0]


def test_pick_on_an_empty_album():
    assert photos.pick_photo([], "random", 5, "pk_x") is None
    assert photos.pick_photo([], "sequential", 0, "pk_x") is None


def test_share_tokens():
    assert photos.valid_share_token("pk_" + "A1_-" * 8)
    assert not photos.valid_share_token("pk_" + "a" * 31)
    assert not photos.valid_share_token("fb_api_" + "a" * 40)
    assert not photos.valid_share_token("pk_" + "a" * 40 + "/../x")
