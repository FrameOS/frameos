"""In-place setup-blob patching of raw SD images (sd_image_blob_patch)."""

from __future__ import annotations

import gzip
import io
import tarfile
from pathlib import Path

import pytest

from app.tasks.sd_image_blob_patch import (
    build_setup_blob_payload,
    find_setup_blob_region,
    patch_setup_blob_into_image,
)
from app.tasks.setup_json_reset import (
    SETUP_BLOB_MAGIC,
    SETUP_BLOB_PLACEHOLDER_SIZE,
    render_setup_blob_placeholder,
    render_setup_blob_region,
)

FILES = {
    "frameos-setup.json": b'{"name": "Patched frame"}',
    "frameos-hostname": b"patched-frame\n",
    "frameos-wifi.nmconnection": b"[wifi]\nssid=PatchNet\n",
}


def _fake_image(tmp_path: Path, *, with_placeholder: bool = True, decoy: bool = False) -> Path:
    # Junk that cannot contain the magic, a decoy occurrence of the magic
    # inside "some other file", then the real placeholder, then more junk —
    # roughly how the region sits inside a FAT partition of a real image.
    image = tmp_path / "fake.img"
    parts = [b"\xa5" * (1024 * 1024)]
    if decoy:
        parts.append(b"documentation: the magic line is " + SETUP_BLOB_MAGIC.encode() + b"\nummm binary\x00\x01")
        parts.append(b"\xa5" * 4096)
    if with_placeholder:
        parts.append(render_setup_blob_placeholder())
    parts.append(b"\x5a" * (1024 * 1024))
    image.write_bytes(b"".join(parts))
    return image


def _extract_blob(region: bytes) -> dict[str, bytes]:
    header_end = region.index(b"\n", region.index(b"\n") + 1) + 1
    size_line = region[: header_end].split(b"\n")[1]
    assert size_line.startswith(b"size=")
    payload_size = int(size_line[len(b"size=") :])
    payload = region[header_end : header_end + payload_size]
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(payload)), mode="r:") as tar:
        for member in tar.getmembers():
            extracted = tar.extractfile(member)
            assert extracted is not None
            files[member.name] = extracted.read()
    return files


def test_round_trip_patch_and_extract(tmp_path):
    image = _fake_image(tmp_path, decoy=True)
    original = image.read_bytes()
    payload = build_setup_blob_payload(FILES)

    assert patch_setup_blob_into_image(image, payload) is True

    patched = image.read_bytes()
    assert len(patched) == len(original)
    offset = find_region_offset_for_test(original)
    # Everything outside the region is untouched.
    assert patched[:offset] == original[:offset]
    assert patched[offset + SETUP_BLOB_PLACEHOLDER_SIZE :] == original[offset + SETUP_BLOB_PLACEHOLDER_SIZE :]
    # The region unpacks to exactly the input files.
    region = patched[offset : offset + SETUP_BLOB_PLACEHOLDER_SIZE]
    assert _extract_blob(region) == FILES


def find_region_offset_for_test(image_bytes: bytes) -> int:
    placeholder = render_setup_blob_placeholder()
    offset = image_bytes.find(placeholder)
    assert offset >= 0
    return offset


def test_decoy_magic_is_skipped(tmp_path):
    image = _fake_image(tmp_path, decoy=True)
    original = image.read_bytes()
    real_offset = find_region_offset_for_test(original)
    assert find_setup_blob_region(image) == real_offset


def test_image_without_placeholder_is_left_alone(tmp_path):
    image = _fake_image(tmp_path, with_placeholder=False, decoy=True)
    original = image.read_bytes()
    assert patch_setup_blob_into_image(image, build_setup_blob_payload(FILES)) is False
    assert image.read_bytes() == original


def test_oversized_payload_is_refused_before_touching_the_image(tmp_path):
    image = _fake_image(tmp_path)
    original = image.read_bytes()
    # Deterministic but incompressible content, so the gzipped payload really
    # overflows the region (a repeating pattern would compress to nothing).
    import hashlib

    digest = b"seed"
    chunks = []
    total = 0
    while total <= SETUP_BLOB_PLACEHOLDER_SIZE:
        digest = hashlib.sha256(digest).digest()
        chunks.append(digest)
        total += len(digest)
    huge = {"frameos-setup.json": b"".join(chunks)}
    with pytest.raises(ValueError):
        patch_setup_blob_into_image(image, build_setup_blob_payload(huge))
    assert image.read_bytes() == original


def test_payload_rejects_unknown_member_names():
    with pytest.raises(ValueError):
        build_setup_blob_payload({"../../etc/passwd": b"nope"})


def test_region_render_is_exactly_placeholder_sized():
    region = render_setup_blob_region(build_setup_blob_payload(FILES))
    assert len(region) == SETUP_BLOB_PLACEHOLDER_SIZE
    assert region.startswith((SETUP_BLOB_MAGIC + "\n").encode("ascii"))
