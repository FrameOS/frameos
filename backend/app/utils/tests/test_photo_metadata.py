"""Photo metadata against its conformance corpus
(docs/photo-metadata-fixtures.json): the reader and both removers. The
cloud's src/lib/photos/metadata.test.ts replays the same files and must give
the same metadata and write the same bytes: a case that passes here and
fails there (or the other way round) is the two planes drifting."""
from __future__ import annotations

import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import pytest
from PIL import Image, ImageFile

from app.utils import photo_metadata, photos
from app.utils.photo_metadata import (
    blank_xmp_gps,
    file_reader,
    minimal_exif_tiff,
    read_exif,
    read_photo_metadata,
    read_photo_metadata_bytes,
    remove_photo_metadata,
    tiff_orientation,
)

REPO = Path(__file__).resolve().parents[4]
FIXTURES_DIR = REPO / "docs" / "photo-metadata-fixtures"
CORPUS = json.loads((REPO / "docs" / "photo-metadata-fixtures.json").read_text())["cases"]
GENERATOR = REPO / "tools" / "generate_photo_metadata_fixtures.py"
CLOUD_MODULE = REPO / "cloud" / "apps" / "auth-web" / "src" / "lib" / "photos" / "metadata.ts"
IMAGES = [case for case in CORPUS if not case["name"].endswith(".gif")]
LOCATED = [case for case in IMAGES if case["removeLocation"]["changed"]]
STRIPPED = [case for case in IMAGES if case["removeAll"]["changed"]]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ids(cases: list[dict]) -> list[str]:
    return [case["name"] for case in cases]


def decoded(data: bytes, truncated: bool = False):
    """The image as Pillow decodes it (a truncated file as far as it goes)."""
    previous = ImageFile.LOAD_TRUNCATED_IMAGES
    ImageFile.LOAD_TRUNCATED_IMAGES = truncated
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = previous


def png_crcs_hold(data: bytes) -> bool:
    at = 8
    while at + 12 <= len(data):
        length = struct.unpack_from(">I", data, at)[0]
        if at + 12 + length > len(data):
            return True
        if zlib.crc32(data[at + 4:at + 8 + length]) & 0xFFFFFFFF != struct.unpack_from(">I", data, at + 8 + length)[0]:
            return False
        if data[at + 4:at + 8] == b"IEND":
            return True
        at += 12 + length
    return True


def test_the_recorded_corpus_is_current():
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_tag_tables_are_the_clouds():
    source = CLOUD_MODULE.read_text()
    for name, table in (
        ("mainTagNames", photo_metadata.MAIN_TAG_NAMES),
        ("gpsTagNames", photo_metadata.GPS_TAG_NAMES),
        ("interopTagNames", photo_metadata.INTEROP_TAG_NAMES),
    ):
        block = source[source.index(f"const {name} = new Map"):]
        block = block[:block.index("]);")]
        cloud = {int(tag, 16): label for tag, label in re.findall(r'\[0x([0-9a-f]{4}), "([^"]+)"\]', block)}
        assert cloud == table, name


@pytest.mark.parametrize("case", CORPUS, ids=ids(CORPUS))
def test_the_corpus_metadata(case):
    data = (FIXTURES_DIR / case["name"]).read_bytes()
    assert sha256(data) == case["inputSha256"]
    assert read_photo_metadata_bytes(data) == case["metadata"]
    with open(FIXTURES_DIR / case["name"], "rb") as handle:
        assert read_photo_metadata(file_reader(handle), len(data)) == case["metadata"]


@pytest.mark.parametrize("case", CORPUS, ids=ids(CORPUS))
def test_the_corpus_bytes(case):
    data = (FIXTURES_DIR / case["name"]).read_bytes()
    for removal, expected in (("location", case["removeLocation"]), ("all", case["removeAll"])):
        result = remove_photo_metadata(data, removal)
        assert sha256(result.data) == expected["sha256"], removal
        assert result.changed == expected["changed"], removal
        if not expected["changed"]:
            assert result.data is data
    assert (remove_photo_metadata(data, "all").problem is not None) == case["removeAll"]["malformed"]


@pytest.mark.parametrize("case", LOCATED, ids=ids(LOCATED))
@pytest.mark.filterwarnings("ignore:Image appears to be a malformed MPO file")
def test_without_its_location_the_same_pixels_length_and_everything_else(case):
    before = (FIXTURES_DIR / case["name"]).read_bytes()
    after = remove_photo_metadata(before, "location").data
    assert len(after) == len(before)
    metadata = read_photo_metadata_bytes(after)
    assert metadata["location"] is None
    assert b"exif:GPS" not in after
    # Every other field is still there; the Location group is gone.
    assert metadata["fields"] == [field for field in case["metadata"]["fields"] if field["group"] != "Location"]
    if case["name"].endswith(".png"):
        assert png_crcs_hold(after)
    if not case["removeAll"]["malformed"]:
        was, now = decoded(before, case["truncated"]), decoded(after, case["truncated"])
        assert now.size == was.size and now.tobytes() == was.tobytes()
        assert now.getexif().get(0x0112) == was.getexif().get(0x0112)
        assert not now.getexif().get_ifd(0x8825)
    # Twice is once.
    assert not remove_photo_metadata(after, "location").changed


@pytest.mark.parametrize("case", STRIPPED, ids=ids(STRIPPED))
@pytest.mark.filterwarnings("ignore:Image appears to be a malformed MPO file")
def test_without_all_metadata_the_same_pixels_the_same_way_up_nothing_planted_left(case):
    before = (FIXTURES_DIR / case["name"]).read_bytes()
    after = remove_photo_metadata(before, "all").data
    was, now = decoded(before, case["truncated"]), decoded(after, case["truncated"])
    assert now.size == was.size
    # Lossless: the decoded pixels are the original's.
    assert now.tobytes() == was.tobytes()
    exif = now.getexif()
    assert (exif.get(0x0112) or 1) == (case["orientation"] or 1)
    # Only the orientation is left: no GPS, no camera, no XMP or text.
    assert set(exif.keys()) <= {0x0112}
    assert not exif.get_ifd(0x8825)
    assert "xmp" not in now.info and "XML:com.adobe.xmp" not in now.info
    assert not {"Comment", "Author", "comment", "Software", "Title"} & set(now.info)
    assert now.info.get("icc_profile") == was.info.get("icc_profile")
    # The backend's size reader sees what it saw.
    assert photos.image_size_of(after) == photos.image_size_of(before)
    for secret in case["secrets"]:
        assert secret.encode() in before
        assert secret.encode() not in after, secret
    if case["name"].endswith(".jpg") and not case["truncated"]:
        # Ends at the primary image's EOI: no second image, no video.
        assert after.endswith(b"\xff\xd9")
    # What is left reads as nothing to remove.
    assert read_photo_metadata_bytes(after)["blocks"] == []
    assert not remove_photo_metadata(after, "all").changed


@pytest.mark.parametrize("case", [case for case in IMAGES if case["metadata"]["location"]], ids=lambda case: case["name"])
@pytest.mark.filterwarnings("ignore:Image appears to be a malformed MPO file")
def test_an_exif_location_is_what_pillow_reads(case):
    """An independent reader agrees on the EXIF GPS (XMP-only cases excluded)."""
    data = (FIXTURES_DIR / case["name"]).read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        gps = image.getexif().get_ifd(0x8825)
    if not gps:
        return
    def degrees(values, ref):
        value = float(values[0]) + float(values[1]) / 60 + float(values[2]) / 3600
        return -value if ref in ("S", "W") else value
    location = case["metadata"]["location"]
    assert location["latitude"] == pytest.approx(degrees(gps[2], gps[1]))
    assert location["longitude"] == pytest.approx(degrees(gps[4], gps[3]))


def test_the_minimal_exif_every_reader_takes():
    assert minimal_exif_tiff(6).hex() == "4d4d002a00000008000101120003000000010006000000000000"
    for orientation in range(1, 9):
        assert tiff_orientation(minimal_exif_tiff(orientation)) == orientation
        assert read_exif(minimal_exif_tiff(orientation)) == (
            [{"group": "Image", "name": "Orientation", "value": orientation}],
            None,
            True,
        )


def big_jpeg() -> tuple[bytes, bytes]:
    """The cloud's test builds the same file (metadata.test.ts bigJpeg)."""
    soi = b"\xff\xd8"
    # Little-endian EXIF, turned 6: replaced by the big-endian minimal block.
    tiff = bytes.fromhex("49492a0008000000010012010300010000000600000000000000")
    app1 = bytes([0xFF, 0xE1, 0, len(tiff) + 8]) + b"Exif\x00\x00" + tiff
    minimal = bytes([0xFF, 0xE1, 0, 34]) + b"Exif\x00\x00" + minimal_exif_tiff(6)
    sof = bytes.fromhex("ffc00011080010001003012200021101031101")
    sos = bytes.fromhex("ffda000c03010002110311003f00")
    # A 0xff as the last byte of the first 1 MiB read, its 0x00 in the next.
    data = b"\x11" * (1024 * 1024 - 1) + b"\xff\x00" + b"\x22" * 1000 + b"\xff\xd3" + b"\x33" * 10 + b"\xff\xff\xd9"
    return soi + app1 + sof + sos + data + b"secret trailer", soi + minimal + sof + sos + data


def test_entropy_data_across_reads_stuffed_bytes_restarts_and_fill_bytes():
    data, expected = big_jpeg()
    assert remove_photo_metadata(data, "all").data == expected
    assert read_photo_metadata_bytes(data)["blocks"] == ["trailer"]


def test_xmp_gps_properties_are_blanked_in_place_and_hostile_packets_are_cheap():
    packet = b'<d exif:GPSLatitude="1,2N" a="b"><exif:GPSSpeed>3</exif:GPSSpeed ></d>'
    assert blank_xmp_gps(packet) == b"<d " + b" " * 23 + b' a="b">' + b" " * 33 + b"</d>"
    hostile = b"<exif:GPSa>" * 200_000 + b'exif:GPSb="'
    started = time.monotonic()
    assert blank_xmp_gps(hostile) is None
    assert time.monotonic() - started < 5


@pytest.mark.parametrize("data", [b"not a photo at all", b"\xff\xd8\xff"])
def test_what_it_does_not_know_is_left_alone(data):
    assert read_photo_metadata_bytes(data) == {"location": None, "fields": [], "blocks": []}
    for removal in ("location", "all"):
        result = remove_photo_metadata(data, removal)
        assert (result.changed, result.format, result.problem) == (False, None, None)
        assert result.data is data
