#!/usr/bin/env python3
"""Writes the photo metadata strip's conformance corpus: small photos with
the metadata cameras and phones write (docs/photo-metadata-fixtures/) and
docs/photo-metadata-fixtures.json, which names each one with the SHA-256 of
what the strip must make of it. The backend (app/utils/photo_metadata.py,
test_photo_metadata.py) and the cloud (src/lib/photos/metadata.ts,
metadata.test.ts) replay it and must both write exactly those bytes.

    python3 tools/generate_photo_metadata_fixtures.py           # re-record the hashes
    python3 tools/generate_photo_metadata_fixtures.py --inputs  # rewrite the inputs too
    python3 tools/generate_photo_metadata_fixtures.py --check   # fail when stale, write nothing

The inputs are committed. They are made with Pillow (pixels, EXIF, ICC) and
then edited byte by byte (XMP, IPTC, comments between scans, trailers), so a
different Pillow may write different inputs: regenerate them only when a case
changes, and re-record (the default) after any change to the strip, then run
both suites.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import sys
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.utils.photo_metadata import strip_photo_metadata  # noqa: E402

FIXTURES_DIR = REPO / "docs" / "photo-metadata-fixtures"
FIXTURES_JSON = REPO / "docs" / "photo-metadata-fixtures.json"

# Strings planted in the metadata. None may be left in a stripped output.
MAKE = "FixtureCam"
SERIAL = "SN-1234567"
XMP = (
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="59,26.2N"/>'
    b"</rdf:RDF></x:xmpmeta>"
)


def image(width: int = 24, height: int = 16, mode: str = "RGB"):
    """A gradient, so a turn shows."""
    from PIL import Image

    picture = Image.new("RGB", (width, height))
    for x in range(width):
        for y in range(height):
            picture.putpixel((x, y), (x * 255 // width, y * 255 // height, 128))
    return picture.convert(mode) if mode != "RGB" else picture


def exif_bytes(orientation: int, endian: str) -> bytes:
    """EXIF the way a phone writes it: camera, serial, time and GPS."""
    from PIL import Image

    exif = Image.Exif()
    exif.endian = endian
    exif[0x010F] = MAKE
    exif[0x0110] = "Model 7"
    exif[0x0112] = orientation
    exif[0x0132] = "2026:10:18 12:00:00"
    details = exif.get_ifd(0x8769)
    details[0x9003] = "2026:10:18 12:00:00"
    details[0xA431] = SERIAL
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (59.0, 26.0, 12.5)
    gps[3] = "E"
    gps[4] = (24.0, 45.0, 1.25)
    return exif.tobytes()


def icc_profile() -> bytes:
    from PIL import ImageCms

    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def jpeg(picture, **options) -> bytes:
    buffer = io.BytesIO()
    picture.save(buffer, "JPEG", quality=75, **options)
    return buffer.getvalue()


def segment(marker: int, payload: bytes) -> bytes:
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def jpeg_segments(data: bytes) -> list[tuple[int, int, int]]:
    """(marker, start, end) of each header segment up to the first SOS."""
    found = []
    pos = 2
    while data[pos + 1] != 0xDA:
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        found.append((data[pos + 1], pos, pos + 2 + length))
        pos += 2 + length
    found.append((0xDA, pos, pos))
    return found


def insert_after(data: bytes, marker: int, extra: bytes) -> bytes:
    """`extra` after the first header segment with this marker."""
    end = next(end for found, _start, end in jpeg_segments(data) if found == marker)
    return data[:end] + extra + data[end:]


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def build_inputs() -> dict[str, bytes]:
    from PIL import PngImagePlugin

    files: dict[str, bytes] = {}
    xmp_app1 = segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + XMP)
    iptc = segment(0xED, b"Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00\x00\x16\x1c\x02\x5a\x00\x12secret IPTC city..")
    ducky = segment(0xEC, b"Ducky\x00\x01\x00\x04\x00\x00\x00\x4b\x00\x00")

    # A phone's photo: EXIF (II, turned 6, GPS, serial), XMP, ICC, IPTC, a comment.
    phone = jpeg(image(), exif=exif_bytes(6, "<"), icc_profile=icc_profile(), comment="secret comment")
    phone = insert_after(phone, 0xE1, xmp_app1 + iptc + ducky)
    files["exif-gps.jpg"] = phone

    # Progressive, EXIF big-endian (turned 8), a comment between two scans.
    progressive = jpeg(image(), exif=exif_bytes(8, ">"), progressive=True)
    first_scan = jpeg_segments(progressive)[-1][1]
    second_scan = progressive.index(b"\xff\xc4", first_scan)
    files["progressive.jpg"] = (
        progressive[:second_scan] + segment(0xFE, b"secret between scans") + progressive[second_scan:]
    )

    # Upright EXIF with GPS, MPF and FlashPix APP2s, and after EOI a second
    # image and a motion photo's video.
    upright = jpeg(image(), exif=exif_bytes(1, "<"))
    upright = insert_after(
        upright,
        0xE1,
        segment(0xE2, b"MPF\x00MM\x00\x2a\x00\x00\x00\x08\x00\x00secret MPF")
        + segment(0xE2, b"FPXR\x00\x00secret FlashPix"),
    )
    second = jpeg(image(12, 8), exif=exif_bytes(1, "<"))
    video = struct.pack(">I", 24) + b"ftypmp42\x00\x00\x00\x00mp42isom" + struct.pack(">I", 24) + b"udta\xa9xyz+59.4366+024.7503/"
    files["mpf-trailer.jpg"] = upright + second + video

    # CMYK: no JFIF APP0, an Adobe APP14 the decoder needs, EXIF turned 5.
    files["cmyk-adobe.jpg"] = jpeg(image(mode="CMYK"), exif=exif_bytes(5, ">"))

    # Nothing to take out: must come back byte for byte.
    files["plain.jpg"] = jpeg(image())

    # Cut in the middle of the scan: stripped, and ends where it ended.
    sos = jpeg_segments(phone)[-1][1]
    scan_data = sos + 2 + struct.unpack(">H", phone[sos + 2:sos + 4])[0]
    files["truncated.jpg"] = phone[: (scan_data + len(phone)) // 2]

    # A stray byte between two header segments: kept as it came.
    malformed = jpeg(image(), exif=exif_bytes(6, "<"))
    after_exif = next(end for marker, _start, end in jpeg_segments(malformed) if marker == 0xE1)
    files["malformed.jpg"] = malformed[:after_exif] + b"\x00" + malformed[after_exif:]

    # PNG: eXIf (turned 6, GPS), tEXt, zTXt, iTXt XMP, tIME, iCCP, pHYs, a trailer.
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "secret comment")
    info.add_text("Author", "secret author", zip=True)
    info.add_itxt("XML:com.adobe.xmp", XMP.decode())
    buffer = io.BytesIO()
    image().save(buffer, "PNG", pnginfo=info, exif=exif_bytes(6, ">"), icc_profile=icc_profile(), dpi=(300, 300))
    png = buffer.getvalue()
    idat = png.index(b"IDAT") - 4
    png = png[:idat] + png_chunk(b"tIME", struct.pack(">HBBBBB", 2026, 10, 18, 12, 0, 0)) + png[idat:]
    files["exif-text.png"] = png + b"secret trailer"

    buffer = io.BytesIO()
    image().save(buffer, "PNG")
    files["plain.png"] = buffer.getvalue()

    # WebP (VP8X): EXIF (turned 6, GPS), XMP, ICC.
    buffer = io.BytesIO()
    image().save(buffer, "WEBP", quality=80, exif=exif_bytes(6, "<"), xmp=XMP, icc_profile=icc_profile())
    files["exif-xmp.webp"] = buffer.getvalue()

    # Lossless WebP, upright EXIF and XMP, and bytes after the RIFF.
    buffer = io.BytesIO()
    image().save(buffer, "WEBP", lossless=True, exif=exif_bytes(1, ">"), xmp=XMP)
    files["upright.webp"] = buffer.getvalue() + b"secret trailer"

    buffer = io.BytesIO()
    image().save(buffer, "WEBP", quality=80)
    files["plain.webp"] = buffer.getvalue()

    # GIF is never touched.
    buffer = io.BytesIO()
    image().save(buffer, "GIF")
    files["plain.gif"] = buffer.getvalue()
    return files


# What each case is about, and what it must come out as.
CASES = [
    ("exif-gps.jpg", "A phone's JPEG: EXIF with GPS and serial, XMP, IPTC, Ducky and a comment go; JFIF and ICC stay; orientation 6 kept", 6),
    ("progressive.jpg", "Progressive JPEG, big-endian EXIF and a comment between scans: every scan kept, orientation 8 kept", 8),
    ("mpf-trailer.jpg", "Upright EXIF, MPF and FlashPix APP2, a second image and a video after EOI: all gone, no EXIF left", None),
    ("cmyk-adobe.jpg", "CMYK JPEG without JFIF: Adobe APP14 stays, the minimal EXIF goes right after SOI, orientation 5", 5),
    ("plain.jpg", "Nothing to take out: the same bytes", None),
    ("truncated.jpg", "Cut short in the scan: metadata gone, the scan kept up to where the file ends", 6),
    ("malformed.jpg", "A stray byte between header segments: cannot be followed, kept as it came", 6),
    ("exif-text.png", "PNG: eXIf, tEXt, zTXt, iTXt, tIME and the trailer go; iCCP and pHYs stay; orientation 6 kept", 6),
    ("plain.png", "Nothing to take out: the same bytes", None),
    ("exif-xmp.webp", "WebP: XMP goes, EXIF becomes the minimal block, VP8X keeps ICC and EXIF flags", 6),
    ("upright.webp", "Lossless WebP: upright EXIF and XMP go with their flags, the bytes after the RIFF too", None),
    ("plain.webp", "Simple WebP: the same bytes", None),
    ("plain.gif", "GIF is never touched", None),
]

PLANTED = [MAKE, SERIAL, "xmpmeta", "secret"]


def record(files: dict[str, bytes]) -> dict:
    cases = []
    for name, description, orientation in CASES:
        data = files[name]
        stripped = strip_photo_metadata(data)
        cases.append({
            "name": name,
            "description": description,
            "inputSha256": hashlib.sha256(data).hexdigest(),
            "outputSha256": hashlib.sha256(stripped.data).hexdigest(),
            "changed": stripped.changed,
            "malformed": stripped.problem is not None,
            "truncated": name == "truncated.jpg",
            "orientation": orientation,
            # Planted in the input; none may be in the output (when it changed).
            "secrets": [secret for secret in PLANTED if secret.encode() in data],
        })
    return {
        "_comment": (
            "The photo metadata strip's conformance corpus (docs/photos.md). Both "
            "app/utils/photo_metadata.py and cloud/apps/auth-web/src/lib/photos/metadata.ts "
            "must turn each input into the bytes with outputSha256. Written by "
            "tools/generate_photo_metadata_fixtures.py; orientation is what the "
            "output must still say (null: upright, no EXIF left)."
        ),
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail when the recorded hashes are stale")
    parser.add_argument("--inputs", action="store_true", help="also rewrite the input files (Pillow-dependent)")
    args = parser.parse_args()

    if args.inputs:
        FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
        for name, data in build_inputs().items():
            (FIXTURES_DIR / name).write_bytes(data)
    files = {name: (FIXTURES_DIR / name).read_bytes() for name, _description, _orientation in CASES}
    text = json.dumps(record(files), indent=2) + "\n"
    if args.check:
        if not FIXTURES_JSON.exists() or FIXTURES_JSON.read_text() != text:
            print(f"{FIXTURES_JSON.relative_to(REPO)} is stale: run {Path(__file__).relative_to(REPO)}", file=sys.stderr)
            return 1
        return 0
    FIXTURES_JSON.write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
