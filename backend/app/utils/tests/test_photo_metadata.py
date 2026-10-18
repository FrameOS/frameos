"""The photo metadata strip against its conformance corpus
(docs/photo-metadata-fixtures.json). The cloud's src/lib/photos/metadata.test.ts
replays the same files and must write the same bytes: a case that passes here
and fails there (or the other way round) is the two planes drifting."""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageFile

from app.utils import photos
from app.utils.photo_metadata import minimal_exif_tiff, strip_photo_metadata, tiff_orientation

REPO = Path(__file__).resolve().parents[4]
FIXTURES_DIR = REPO / "docs" / "photo-metadata-fixtures"
CORPUS = json.loads((REPO / "docs" / "photo-metadata-fixtures.json").read_text())["cases"]
GENERATOR = REPO / "tools" / "generate_photo_metadata_fixtures.py"
CHANGED = [case for case in CORPUS if case["changed"]]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decoded(data: bytes, truncated: bool):
    """The image as Pillow decodes it (a truncated file as far as it goes)."""
    previous = ImageFile.LOAD_TRUNCATED_IMAGES
    ImageFile.LOAD_TRUNCATED_IMAGES = truncated
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = previous


def test_the_recorded_hashes_are_current():
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("case", CORPUS, ids=[case["name"] for case in CORPUS])
def test_the_corpus_bytes(case):
    data = (FIXTURES_DIR / case["name"]).read_bytes()
    assert sha256(data) == case["inputSha256"]
    result = strip_photo_metadata(data)
    assert sha256(result.data) == case["outputSha256"]
    assert result.changed == case["changed"]
    assert (result.problem is not None) == case["malformed"]
    if not case["changed"]:
        assert result.data is data


@pytest.mark.parametrize("case", CHANGED, ids=[case["name"] for case in CHANGED])
@pytest.mark.filterwarnings("ignore:Image appears to be a malformed MPO file")
def test_the_same_pixels_the_same_way_up_nothing_planted_left(case):
    before = (FIXTURES_DIR / case["name"]).read_bytes()
    after = strip_photo_metadata(before).data
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
    assert not {"Comment", "Author", "comment"} & set(now.info)
    assert now.info.get("icc_profile") == was.info.get("icc_profile")
    # The backend's size reader sees what it saw.
    assert photos.image_size_of(after) == photos.image_size_of(before)
    for secret in case["secrets"]:
        assert secret.encode() in before
        assert secret.encode() not in after, secret
    if case["name"].endswith(".jpg") and not case["truncated"]:
        # Ends at the primary image's EOI: no second image, no video.
        assert after.endswith(b"\xff\xd9")


def test_the_minimal_exif_every_reader_takes():
    assert minimal_exif_tiff(6).hex() == "4d4d002a00000008000101120003000000010006000000000000"
    for orientation in range(1, 9):
        assert tiff_orientation(minimal_exif_tiff(orientation)) == orientation


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
    assert strip_photo_metadata(data).data == expected


@pytest.mark.parametrize("data", [b"not a photo at all", b"\xff\xd8\xff"])
def test_what_it_does_not_know_is_left_alone(data):
    result = strip_photo_metadata(data)
    assert (result.changed, result.format, result.problem) == (False, None, None)
    assert result.data is data
