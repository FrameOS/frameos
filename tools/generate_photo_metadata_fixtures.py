#!/usr/bin/env python3
"""Writes the photo metadata conformance corpus: small photos with the
metadata cameras and phones write (docs/photo-metadata-fixtures/) and
docs/photo-metadata-fixtures.json, which names each one with the Metadata
object the reader must give and the SHA-256 of what `remove: "location"` and
`remove: "all"` must make of it (docs/photos.md "Metadata"). The backend
(app/utils/photo_metadata.py, test_photo_metadata.py) and the cloud
(src/lib/photos/metadata.ts, metadata.test.ts) replay it and must agree on
every value and every byte.

    python3 tools/generate_photo_metadata_fixtures.py           # re-record the expectations
    python3 tools/generate_photo_metadata_fixtures.py --inputs  # also write inputs that are missing
    python3 tools/generate_photo_metadata_fixtures.py --check   # fail when stale, write nothing

The inputs are committed. They are made with Pillow (pixels, EXIF, ICC), a
small TIFF writer here (every EXIF type, both byte orders) and edits byte by
byte (XMP, IPTC, comments between scans, trailers), so a different Pillow
may write different inputs: `--inputs` only writes the ones not there yet
(delete one to remake it). Re-record (the default) after any change to the
reader or a remover, then run both suites.
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

from app.utils.photo_metadata import read_photo_metadata_bytes, remove_photo_metadata  # noqa: E402

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


TIFF_TYPES = {
    "BYTE": (1, "B"), "ASCII": (2, None), "SHORT": (3, "H"), "LONG": (4, "I"), "RATIONAL": (5, "II"),
    "SBYTE": (6, "b"), "UNDEFINED": (7, None), "SSHORT": (8, "h"), "SLONG": (9, "i"), "SRATIONAL": (10, "ii"),
    "FLOAT": (11, "f"), "DOUBLE": (12, "d"),
}


def tiff(endian: str, ifds: dict[str, list[tuple[int, str, object]]]) -> bytes:
    """A TIFF (EXIF block) with IFD0, and the Exif, GPS, Interoperability and
    IFD1 directories that `ifds` names, each entry (tag, type, value): a str
    for ASCII, bytes for UNDEFINED, else a list of numbers (pairs for the
    rationals). Pointers are added; entries are sorted by tag."""
    order = ["ifd0", "exif", "gps", "interop", "ifd1"]
    ifds = {name: list(ifds.get(name, [])) for name in order}
    if ifds["exif"]:
        ifds["ifd0"].append((0x8769, "LONG", [0]))
    if ifds["gps"]:
        ifds["ifd0"].append((0x8825, "LONG", [0]))
    if ifds["interop"]:
        ifds["exif"].append((0xA005, "LONG", [0]))
    present = [name for name in order if ifds[name]]
    offsets: dict[str, int] = {}
    at = 8
    for name in present:
        offsets[name] = at
        at += 2 + 12 * len(ifds[name]) + 4
    pointers = {0x8769: "exif", 0x8825: "gps", 0xA005: "interop"}
    head = (b"II" if endian == "<" else b"MM") + struct.pack(endian + "HI", 42, 8)
    body = b""
    data = b""
    data_at = at
    for name in present:
        entries = sorted(ifds[name], key=lambda entry: entry[0])
        body += struct.pack(endian + "H", len(entries))
        for tag, kind, value in entries:
            code, fmt = TIFF_TYPES[kind]
            if tag in pointers:
                value = [offsets[pointers[tag]]]
            if kind == "ASCII":
                raw = str(value).encode() + b"\x00"
                count = len(raw)
            elif kind == "UNDEFINED":
                raw = bytes(value)  # type: ignore[arg-type]
                count = len(raw)
            else:
                items = list(value)  # type: ignore[call-overload]
                count = len(items)
                raw = b"".join(struct.pack(endian + fmt, *(item if isinstance(item, tuple) else (item,))) for item in items)
            if len(raw) <= 4:
                field = raw.ljust(4, b"\x00")
            else:
                field = struct.pack(endian + "I", data_at + len(data))
                data += raw + (b"\x00" if len(raw) % 2 else b"")
            body += struct.pack(endian + "HHI", tag, code, count) + field
        following = offsets["ifd1"] if name == "ifd0" and "ifd1" in offsets else 0
        body += struct.pack(endian + "I", following)
    return head + body + data


def every_type_exif(endian: str) -> bytes:
    """EXIF with every TIFF type, every group, a long and a UTF-8 string, and
    a location south and west, below sea level."""
    return tiff(endian, {
        "ifd0": [
            (0x010F, "ASCII", MAKE),
            (0x0110, "ASCII", "Model 7"),
            (0x0112, "SHORT", [6]),
            (0x011A, "RATIONAL", [(72, 1)]),
            (0x0128, "SHORT", [2]),
            (0x0131, "ASCII", "Fixture Paint " + "x" * 300),
            (0x0132, "ASCII", "2026:07:14 18:22:05"),
            (0x013B, "ASCII", "J\u00fcri \u00d5un"),
            (0x8298, "ASCII", "Fixture   "),
            (0x9999, "SHORT", [1, 2, 3]),
        ],
        "exif": [
            (0x829A, "RATIONAL", [(1, 250)]),
            (0x829D, "RATIONAL", [(28, 10)]),
            (0x8827, "SHORT", [200]),
            (0x9000, "UNDEFINED", b"0232"),
            (0x9003, "ASCII", "2026:07:14 18:22:05"),
            (0x9011, "ASCII", "+03:00"),
            (0x9101, "UNDEFINED", b"\x01\x02\x03\x00"),
            (0x9204, "SRATIONAL", [(-1, 3)]),
            (0x920A, "RATIONAL", [(50, 0)]),
            (0x9214, "SHORT", list(range(20))),
            (0x927C, "UNDEFINED", bytes(range(40))),
            (0x9286, "UNDEFINED", b"ASCII\x00\x00\x00secret user comment"),
            (0x9400, "SRATIONAL", [(-55, 10)]),
            (0x9990, "SBYTE", [-5]),
            (0x9991, "SSHORT", [-300, 7]),
            (0x9992, "SLONG", [-70000]),
            (0x9997, "DOUBLE", [2.25, float("nan")]),
            (0x9998, "FLOAT", [1.5]),
            (0xA430, "ASCII", "secret owner"),
            (0xA431, "ASCII", SERIAL),
            (0xA434, "ASCII", "Fixture 50mm"),
        ],
        "gps": [
            (0x0000, "BYTE", [2, 3, 0, 0]),
            (0x0001, "ASCII", "S"),
            (0x0002, "RATIONAL", [(12, 1), (2, 1), (4716, 100)]),
            (0x0003, "ASCII", "W"),
            (0x0004, "RATIONAL", [(77, 1), (2, 1), (342, 10)]),
            (0x0005, "BYTE", [1]),
            (0x0006, "RATIONAL", [(155, 10)]),
            (0x0007, "RATIONAL", [(18, 1), (22, 1), (5, 1)]),
            (0x001B, "UNDEFINED", b"ASCII\x00\x00\x00GPS"),
            (0x001D, "ASCII", "2026:07:14"),
        ],
        "interop": [
            (0x0001, "ASCII", "R98"),
            (0x0002, "UNDEFINED", b"0100"),
        ],
        "ifd1": [
            (0x0103, "SHORT", [6]),
            (0x0201, "LONG", [0]),
            (0x0202, "LONG", [0]),
        ],
    })


def build_inputs() -> dict[str, bytes]:
    from PIL import Image, PngImagePlugin

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

    # Every EXIF type and group, little- and big-endian, located south-west.
    for endian, name in (("<", "every-type-ii.jpg"), (">", "every-type-mm.jpg")):
        files[name] = insert_after(jpeg(image()), 0xE0, segment(0xE1, b"Exif\x00\x00" + every_type_exif(endian)))

    # GPS only in XMP: a JPEG with camera EXIF and attribute-form XMP, and a
    # PNG with element-form XMP ("DDD,MM.mmk") next to text chunks.
    camera = Image.Exif()
    camera[0x010F] = MAKE
    camera[0x0112] = 3
    xmp_attributes = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSVersionID="2.2.0.0"'
        b' exif:GPSLatitude="59,26.2N" exif:GPSLongitude=\'24,45,12.25E\' exif:GPSAltitude="315/10"'
        b' xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"/></rdf:RDF></x:xmpmeta>'
    )
    files["xmp-gps.jpg"] = insert_after(
        jpeg(image(), exif=camera.tobytes()), 0xE1, segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + xmp_attributes)
    )
    xmp_elements = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/">'
        "<exif:GPSLatitude>40,26.767N</exif:GPSLatitude>\n"
        "<exif:GPSLongitude >79,58.933W</exif:GPSLongitude >\n"
        '<exif:GPSMapDatum rdf:parseType="Literal"/>\n'
        "<exif:GPSTimeStamp>2026-07-14T18:22:05Z</exif:GPSTimeStamp>"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    info = PngImagePlugin.PngInfo()
    info.add_text("Software", "Fixture Paint")
    info.add_itxt("Title", "Tallinn \u2713", lang="et", tkey="Pealkiri")
    info.add_itxt("Description", "secret description", zip=True)
    info.add_text("Author", "secret author", zip=True)
    info.add_itxt("XML:com.adobe.xmp", xmp_elements)
    buffer = io.BytesIO()
    image().save(buffer, "PNG", pnginfo=info)
    files["xmp-gps.png"] = buffer.getvalue()
    return files


# What each case is about. `orientation` is what "remove all" must leave
# (null: upright, no EXIF left).
CASES = [
    ("exif-gps.jpg", "A phone's JPEG: little-endian EXIF with GPS and serial, XMP with a GPS latitude, IPTC, Ducky, a comment, ICC", 6),
    ("progressive.jpg", "Progressive JPEG, big-endian EXIF with GPS and a comment between scans: every scan kept", 8),
    ("mpf-trailer.jpg", "Upright EXIF with GPS, MPF and FlashPix APP2, a second image and a video after EOI", None),
    ("cmyk-adobe.jpg", "CMYK JPEG without JFIF: Adobe APP14 stays, the minimal EXIF goes right after SOI", 5),
    ("every-type-ii.jpg", "Every EXIF type and group, little-endian, located south and west below sea level", 6),
    ("every-type-mm.jpg", "The same EXIF big-endian: the same metadata", 6),
    ("xmp-gps.jpg", "GPS only in XMP attributes (DDD,MM.mmk and DDD,MM,SSk): the location comes from XMP", 3),
    ("plain.jpg", "Nothing to read, nothing to remove: the same bytes", None),
    ("truncated.jpg", "Cut short in the scan: read and stripped up to where the file ends", 6),
    ("malformed.jpg", "A stray byte between header segments: read up to it; all is kept, the location still goes", 6),
    ("exif-text.png", "PNG: eXIf with GPS (its CRC redone), tEXt, zTXt, iTXt XMP, tIME, iCCP, pHYs and a trailer", 6),
    ("xmp-gps.png", "PNG: GPS only in iTXt XMP elements, next to tEXt, zTXt and compressed and plain iTXt", None),
    ("plain.png", "Nothing to read, nothing to remove: the same bytes", None),
    ("exif-xmp.webp", "WebP: EXIF with GPS, XMP with a GPS latitude, ICC", 6),
    ("upright.webp", "Lossless WebP: upright EXIF with GPS and XMP, and bytes after the RIFF", None),
    ("plain.webp", "Simple WebP: the same bytes", None),
    ("plain.gif", "GIF is never read or touched", None),
]

PLANTED = [MAKE, SERIAL, "xmpmeta", "secret"]


def record(files: dict[str, bytes]) -> dict:
    cases = []
    for name, description, orientation in CASES:
        data = files[name]
        location = remove_photo_metadata(data, "location")
        everything = remove_photo_metadata(data, "all")
        cases.append({
            "name": name,
            "description": description,
            "inputSha256": hashlib.sha256(data).hexdigest(),
            "metadata": read_photo_metadata_bytes(data),
            "removeLocation": {
                "sha256": hashlib.sha256(location.data).hexdigest(),
                "changed": location.changed,
            },
            "removeAll": {
                "sha256": hashlib.sha256(everything.data).hexdigest(),
                "changed": everything.changed,
                "malformed": everything.problem is not None,
            },
            "truncated": name == "truncated.jpg",
            "orientation": orientation,
            # Planted in the input; none may be left after "remove all" (when it changed).
            "secrets": [secret for secret in PLANTED if secret.encode() in data],
        })
    return {
        "_comment": (
            "The photo metadata conformance corpus (docs/photos.md \"Metadata\"). Both "
            "app/utils/photo_metadata.py and cloud/apps/auth-web/src/lib/photos/metadata.ts "
            "must read each input as `metadata` and turn it into the bytes with "
            "removeLocation.sha256 and removeAll.sha256. Written by "
            "tools/generate_photo_metadata_fixtures.py; `orientation` is what the "
            "removeAll output must still say (null: upright, no EXIF left)."
        ),
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail when the recorded hashes are stale")
    parser.add_argument("--inputs", action="store_true", help="also write the inputs that are missing (Pillow-dependent)")
    args = parser.parse_args()

    if args.inputs:
        FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
        for name, data in build_inputs().items():
            if not (FIXTURES_DIR / name).exists():
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
