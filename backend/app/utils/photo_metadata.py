"""What a photo carries besides its pixels, and the two removals its owner
can ask for (docs/photos.md "Metadata", POST /api/photos/metadata). Uploads
are stored exactly as sent: the library reads the metadata to inform (a
location pin, the viewer's Info panel) and rewrites a photo only when asked.

- The read: every EXIF field by group, the location (EXIF GPS, else XMP
  exif:GPS*), PNG text chunks, and which other blocks the file holds (XMP,
  IPTC, comments, text, a trailer such as a motion photo's video).
- `remove="location"`: the EXIF GPS IFD is cut out of IFD0 and its bytes
  zeroed, XMP GPS properties are blanked with spaces. In place: the file
  keeps its length and every other byte (a changed PNG chunk gets its CRC
  again).
- `remove="all"`: lossless and byte-level, no pixel re-encoded. JPEG: APP0
  (JFIF), APP2 ICC_PROFILE, APP14 Adobe and every structural segment stay;
  APP1 (EXIF, XMP), the other APPn, COM and everything after the primary
  image's EOI go. PNG: eXIf, tEXt, zTXt, iTXt and tIME go, and whatever
  follows IEND. WebP: the EXIF and XMP chunks go, the RIFF size and the VP8X
  flags follow. An EXIF orientation other than 1 survives as a minimal EXIF
  block (one IFD0 entry, big-endian).
- GIF and anything else (the backend stores any file): nothing read,
  nothing changed.

A JPEG, PNG or WebP whose structure cannot be followed to the end is read as
far as it goes; "all" leaves it as it is (its `problem` says why), "location"
still edits the blocks found before the problem.

The cloud's cloud/apps/auth-web/src/lib/photos/metadata.ts is the same
procedure, rule for rule: both planes replay docs/photo-metadata-fixtures.json
and must give the same metadata and write byte-identical files. Change one,
change both, re-record the corpus (tools/generate_photo_metadata_fixtures.py).

The photo is read at offsets through `read(offset, length)` (segment lengths
skip payloads unread, entropy data is scanned in chunks), so a photo on disk
is never read whole.
"""
from __future__ import annotations

import math
import re
import struct
import zlib
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Callable, Optional, Union

# The most of an EXIF block read for its orientation by "remove all": what a
# JPEG's APP1 segment can hold. IFD0 sits at its start in every camera's file.
MAX_EXIF_BYTES = 65536
# The most of one EXIF or XMP block read, or rewritten, by the reader and
# "remove location".
MAX_BLOCK_BYTES = 16 * 1024 * 1024
# The most of a PNG text chunk read for its field.
MAX_TEXT_BYTES = 65536
MAX_FIELDS = 500
MAX_STRING_LENGTH = 256
WINDOW_BYTES = 64 * 1024
SCAN_CHUNK_BYTES = 1024 * 1024

EXIF_HEADER = b"Exif\x00\x00"
XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"
XMP_EXTENSION_HEADER = b"http://ns.adobe.com/xmp/extension/\x00"
# The extension's namespace, then a 32-byte GUID, the full length and this
# part's offset.
XMP_EXTENSION_SKIP = len(XMP_EXTENSION_HEADER) + 32 + 4 + 4
ICC_HEADER = b"ICC_PROFILE\x00"
ADOBE_HEADER = b"Adobe"
USER_COMMENT_ASCII = b"ASCII\x00\x00\x00"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DROPPED_PNG_CHUNKS = {b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME"}
XMP_KEYWORD = "XML:com.adobe.xmp"
WEBP_EXIF_FLAG = 0x08
WEBP_XMP_FLAG = 0x04
BLOCK_ORDER = ["exif", "xmp", "iptc", "comment", "text", "trailer", "other"]
REMOVALS = ("location", "all")

POINTER_TAGS = {0x8769, 0x8825, 0xA005}

# Tag names (EXIF 2.32, TIFF 6, the GPS IFD), the names exiv2 gives them. The
# cloud's metadata.ts carries the same three tables; test_photo_metadata.py
# compares them.
MAIN_TAG_NAMES = {
    0x000B: "ProcessingSoftware",
    0x00FE: "NewSubfileType",
    0x00FF: "SubfileType",
    0x0100: "ImageWidth",
    0x0101: "ImageLength",
    0x0102: "BitsPerSample",
    0x0103: "Compression",
    0x0106: "PhotometricInterpretation",
    0x010D: "DocumentName",
    0x010E: "ImageDescription",
    0x010F: "Make",
    0x0110: "Model",
    0x0111: "StripOffsets",
    0x0112: "Orientation",
    0x0115: "SamplesPerPixel",
    0x0116: "RowsPerStrip",
    0x0117: "StripByteCounts",
    0x011A: "XResolution",
    0x011B: "YResolution",
    0x011C: "PlanarConfiguration",
    0x0128: "ResolutionUnit",
    0x012D: "TransferFunction",
    0x0131: "Software",
    0x0132: "DateTime",
    0x013B: "Artist",
    0x013C: "HostComputer",
    0x013E: "WhitePoint",
    0x013F: "PrimaryChromaticities",
    0x0201: "JPEGInterchangeFormat",
    0x0202: "JPEGInterchangeFormatLength",
    0x0211: "YCbCrCoefficients",
    0x0212: "YCbCrSubSampling",
    0x0213: "YCbCrPositioning",
    0x0214: "ReferenceBlackWhite",
    0x02BC: "XMLPacket",
    0x4746: "Rating",
    0x4749: "RatingPercent",
    0x8298: "Copyright",
    0x829A: "ExposureTime",
    0x829D: "FNumber",
    0x83BB: "IPTCNAA",
    0x8773: "InterColorProfile",
    0x8822: "ExposureProgram",
    0x8824: "SpectralSensitivity",
    0x8827: "ISOSpeedRatings",
    0x8828: "OECF",
    0x8830: "SensitivityType",
    0x8831: "StandardOutputSensitivity",
    0x8832: "RecommendedExposureIndex",
    0x8833: "ISOSpeed",
    0x8834: "ISOSpeedLatitudeyyy",
    0x8835: "ISOSpeedLatitudezzz",
    0x9000: "ExifVersion",
    0x9003: "DateTimeOriginal",
    0x9004: "DateTimeDigitized",
    0x9010: "OffsetTime",
    0x9011: "OffsetTimeOriginal",
    0x9012: "OffsetTimeDigitized",
    0x9101: "ComponentsConfiguration",
    0x9102: "CompressedBitsPerPixel",
    0x9201: "ShutterSpeedValue",
    0x9202: "ApertureValue",
    0x9203: "BrightnessValue",
    0x9204: "ExposureBiasValue",
    0x9205: "MaxApertureValue",
    0x9206: "SubjectDistance",
    0x9207: "MeteringMode",
    0x9208: "LightSource",
    0x9209: "Flash",
    0x920A: "FocalLength",
    0x9214: "SubjectArea",
    0x927C: "MakerNote",
    0x9286: "UserComment",
    0x9290: "SubSecTime",
    0x9291: "SubSecTimeOriginal",
    0x9292: "SubSecTimeDigitized",
    0x9400: "Temperature",
    0x9401: "Humidity",
    0x9402: "Pressure",
    0x9403: "WaterDepth",
    0x9404: "Acceleration",
    0x9405: "CameraElevationAngle",
    0x9C9B: "XPTitle",
    0x9C9C: "XPComment",
    0x9C9D: "XPAuthor",
    0x9C9E: "XPKeywords",
    0x9C9F: "XPSubject",
    0xA000: "FlashpixVersion",
    0xA001: "ColorSpace",
    0xA002: "PixelXDimension",
    0xA003: "PixelYDimension",
    0xA004: "RelatedSoundFile",
    0xA20B: "FlashEnergy",
    0xA20C: "SpatialFrequencyResponse",
    0xA20E: "FocalPlaneXResolution",
    0xA20F: "FocalPlaneYResolution",
    0xA210: "FocalPlaneResolutionUnit",
    0xA214: "SubjectLocation",
    0xA215: "ExposureIndex",
    0xA217: "SensingMethod",
    0xA300: "FileSource",
    0xA301: "SceneType",
    0xA302: "CFAPattern",
    0xA401: "CustomRendered",
    0xA402: "ExposureMode",
    0xA403: "WhiteBalance",
    0xA404: "DigitalZoomRatio",
    0xA405: "FocalLengthIn35mmFilm",
    0xA406: "SceneCaptureType",
    0xA407: "GainControl",
    0xA408: "Contrast",
    0xA409: "Saturation",
    0xA40A: "Sharpness",
    0xA40B: "DeviceSettingDescription",
    0xA40C: "SubjectDistanceRange",
    0xA420: "ImageUniqueID",
    0xA430: "CameraOwnerName",
    0xA431: "BodySerialNumber",
    0xA432: "LensSpecification",
    0xA433: "LensMake",
    0xA434: "LensModel",
    0xA435: "LensSerialNumber",
    0xA460: "CompositeImage",
    0xA461: "SourceImageNumberOfCompositeImage",
    0xA462: "SourceExposureTimesOfCompositeImage",
    0xA500: "Gamma",
    0xC4A5: "PrintImageMatching",
    0xEA1C: "Padding",
}

GPS_TAG_NAMES = {
    0x0000: "GPSVersionID",
    0x0001: "GPSLatitudeRef",
    0x0002: "GPSLatitude",
    0x0003: "GPSLongitudeRef",
    0x0004: "GPSLongitude",
    0x0005: "GPSAltitudeRef",
    0x0006: "GPSAltitude",
    0x0007: "GPSTimeStamp",
    0x0008: "GPSSatellites",
    0x0009: "GPSStatus",
    0x000A: "GPSMeasureMode",
    0x000B: "GPSDOP",
    0x000C: "GPSSpeedRef",
    0x000D: "GPSSpeed",
    0x000E: "GPSTrackRef",
    0x000F: "GPSTrack",
    0x0010: "GPSImgDirectionRef",
    0x0011: "GPSImgDirection",
    0x0012: "GPSMapDatum",
    0x0013: "GPSDestLatitudeRef",
    0x0014: "GPSDestLatitude",
    0x0015: "GPSDestLongitudeRef",
    0x0016: "GPSDestLongitude",
    0x0017: "GPSDestBearingRef",
    0x0018: "GPSDestBearing",
    0x0019: "GPSDestDistanceRef",
    0x001A: "GPSDestDistance",
    0x001B: "GPSProcessingMethod",
    0x001C: "GPSAreaInformation",
    0x001D: "GPSDateStamp",
    0x001E: "GPSDifferential",
    0x001F: "GPSHPositioningError",
}

INTEROP_TAG_NAMES = {
    0x0001: "InteroperabilityIndex",
    0x0002: "InteroperabilityVersion",
    0x1000: "RelatedImageFileFormat",
    0x1001: "RelatedImageWidth",
    0x1002: "RelatedImageLength",
}

Reader = Callable[[int, int], bytes]


@dataclass
class Range:
    """A stretch of the input kept as it is."""

    start: int
    end: int


Piece = Union[Range, bytes, bytearray]


@dataclass
class Region:
    start: int
    length: int


@dataclass
class Block:
    """An EXIF or XMP block, and the PNG chunk data it lies in (its CRC follows)."""

    start: int
    length: int
    chunk: Optional[Region]


@dataclass
class Survey:
    """One walk over the file: what every reader and remover here works from."""

    format: Optional[str]
    # The "remove all" result; None when it changes nothing or cannot run.
    all: Optional[list[Piece]] = None
    problem: Optional[str] = None
    blocks: set[str] = field(default_factory=set)
    # The TIFF bytes of the first EXIF block.
    exif: Optional[Block] = None
    exif_blocks: int = 0
    texts: list[tuple[str, Region]] = field(default_factory=list)
    # Uncompressed XMP packets, in file order.
    xmp: list[Block] = field(default_factory=list)


@dataclass
class RewrittenPhoto:
    data: bytes
    changed: bool
    format: Optional[str]
    # Why a JPEG, PNG or WebP could not be followed to its end.
    problem: Optional[str]


# Kept for the name the upload path used before uploads stopped stripping.
StrippedPhoto = RewrittenPhoto


def empty_metadata() -> dict[str, Any]:
    return {"location": None, "fields": [], "blocks": []}


def tiff_orientation(tiff: bytes) -> Optional[int]:
    """The orientation tag (1-8) in IFD0 of a bare EXIF TIFF block, if any:
    the cloud's image-info.ts tiffOrientation, line for line."""
    if len(tiff) < 8:
        return None
    byte_order = tiff[0:2]
    little = byte_order == b"II"
    if not little and byte_order != b"MM":
        return None
    u16 = "<H" if little else ">H"
    u32 = "<I" if little else ">I"

    def read16(at: int) -> int:
        return struct.unpack_from(u16, tiff, at)[0]

    if read16(2) != 42:
        return None
    ifd = struct.unpack_from(u32, tiff, 4)[0]
    if ifd + 2 > len(tiff):
        return None
    count = read16(ifd)
    for index in range(count):
        entry = ifd + 2 + index * 12
        if entry + 12 > len(tiff):
            return None
        if read16(entry) == 0x0112:
            # Type SHORT, count 1: the value sits in the first two bytes of
            # the value field.
            value = read16(entry + 8)
            return value if 1 <= value <= 8 else None
    return None


def minimal_exif_tiff(orientation: int) -> bytes:
    """The smallest EXIF that still turns the photo: a big-endian TIFF whose
    IFD0 holds one entry, Orientation (0x0112) SHORT 1 = `orientation`, and
    no next IFD. Browsers, sharp, Pillow and the frames' pixie all read it."""
    return b"MM" + struct.pack(">HIHHHIHHI", 42, 8, 1, 0x0112, 3, 1, orientation, 0, 0)


def _minimal_jpeg_app1(orientation: int) -> bytes:
    payload = EXIF_HEADER + minimal_exif_tiff(orientation)
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def _crc(data: bytes) -> bytes:
    return struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)


def _minimal_png_exif(orientation: int) -> bytes:
    body = b"eXIf" + minimal_exif_tiff(orientation)
    return struct.pack(">I", len(body) - 4) + body + _crc(body)


def _minimal_webp_exif(orientation: int) -> bytes:
    tiff = minimal_exif_tiff(orientation)
    return b"EXIF" + struct.pack("<I", len(tiff)) + tiff


def _chunk_orientation(block: bytes) -> Optional[int]:
    """An EXIF chunk's payload: a bare TIFF, or (some writers) "Exif\\0\\0" first."""
    return tiff_orientation(block[6:] if block.startswith(EXIF_HEADER) else block)


class _Source:
    """Single bytes through a window, so walking segment headers is not a read each."""

    def __init__(self, read: Reader, size: int):
        self._read = read
        self.size = size
        self._window = b""
        self._window_start = 0

    def byte(self, offset: int) -> Optional[int]:
        if offset < 0 or offset >= self.size:
            return None
        if offset < self._window_start or offset >= self._window_start + len(self._window):
            self._window = self._read(offset, min(WINDOW_BYTES, self.size - offset))
            self._window_start = offset
        return self._window[offset - self._window_start]

    def read(self, offset: int, length: int) -> bytes:
        """Up to `length` bytes at `offset`: fewer at the end of the file."""
        available = max(0, min(length, self.size - offset))
        return b"" if available == 0 else self._read(offset, available)


class _Pieces:
    def __init__(self) -> None:
        self.list: list[Piece] = []

    def keep(self, start: int, end: int) -> None:
        if end <= start:
            return
        last = self.list[-1] if self.list else None
        if isinstance(last, Range) and last.end == start:
            last.end = end
        else:
            self.list.append(Range(start, end))

    def add(self, data: bytes | bytearray) -> None:
        self.list.append(data)

    def is_whole(self, size: int) -> bool:
        return len(self.list) == 1 and isinstance(self.list[0], Range) and self.list[0].start == 0 and self.list[0].end == size


def _entropy_end(source: _Source, start: int) -> int:
    """Where the entropy-coded data that starts at `start` ends: the 0xff of
    the next marker (fill bytes included), or the end of the file. In the
    data a 0xff is followed by 0x00 (a stuffed byte) or a restart marker."""
    pos = start
    while pos < source.size:
        chunk = source.read(pos, SCAN_CHUNK_BYTES)
        at = chunk.find(b"\xff")
        while at != -1 and at + 1 < len(chunk):
            following = chunk[at + 1]
            if following != 0x00 and not (0xD0 <= following <= 0xD7):
                return pos + at
            at = chunk.find(b"\xff", at + 2)
        if at == -1:
            pos += len(chunk)
        elif pos + len(chunk) >= source.size:
            # A 0xff that is the file's last byte.
            return source.size
        else:
            # The byte after this 0xff is in the next read.
            pos += at
    return source.size


def _survey_jpeg(source: _Source) -> Survey:
    size = source.size
    survey = Survey("jpeg")
    pieces = _Pieces()
    pieces.keep(0, 2)
    # The minimal APP1 goes after SOI and the APP0 segments right behind it.
    insert_at = 2
    leading = True
    orientation: Optional[int] = None
    scanned = False
    pos = 2
    while pos < size:
        start = pos
        if source.byte(pos) != 0xFF:
            survey.problem = f"no marker at byte {pos}"
            return survey
        # Any number of 0xff fill bytes may precede a marker.
        at = pos + 1
        while source.byte(at) == 0xFF:
            at += 1
        marker = source.byte(at)
        if marker is None:
            pieces.keep(start, size)
            break
        if marker == 0x00:
            survey.problem = f"no marker at byte {pos}"
            return survey
        if marker == 0xD9:
            # The primary image's end: whatever follows (MPF images, a motion
            # photo's video) is a trailer.
            pieces.keep(start, at + 1)
            if at + 1 < size:
                survey.blocks.add("trailer")
            break
        # Standalone markers have no length: TEM, RST0-7, SOI.
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            pieces.keep(start, at + 1)
            leading = False
            pos = at + 1
            continue
        if at + 3 > size:
            pieces.keep(start, size)
            break
        length = (source.byte(at + 1) or 0) << 8 | (source.byte(at + 2) or 0)
        if length < 2:
            survey.problem = f"segment length {length} at byte {pos}"
            return survey
        payload = at + 3
        end = at + 1 + length
        stop = min(end, size)
        if marker == 0xE1:
            kept = False
            head = source.read(payload, stop - payload)
            if head.startswith(EXIF_HEADER):
                survey.blocks.add("exif")
                survey.exif_blocks += 1
                if survey.exif is None and not scanned:
                    survey.exif = Block(payload + 6, stop - payload - 6, None)
                    orientation = tiff_orientation(head[6:])
            elif head.startswith(XMP_HEADER):
                survey.blocks.add("xmp")
                survey.xmp.append(Block(payload + len(XMP_HEADER), stop - payload - len(XMP_HEADER), None))
            elif head.startswith(XMP_EXTENSION_HEADER):
                survey.blocks.add("xmp")
                if stop - payload > XMP_EXTENSION_SKIP:
                    survey.xmp.append(Block(payload + XMP_EXTENSION_SKIP, stop - payload - XMP_EXTENSION_SKIP, None))
            else:
                survey.blocks.add("other")
        elif marker == 0xE2:
            kept = source.read(payload, len(ICC_HEADER)) == ICC_HEADER
        elif marker == 0xEE:
            kept = source.read(payload, len(ADOBE_HEADER)) == ADOBE_HEADER
        elif 0xE3 <= marker <= 0xEF or marker == 0xFE:
            kept = False
            survey.blocks.add("iptc" if marker == 0xED else "comment" if marker == 0xFE else "other")
        else:
            # APP0 and every structural segment: tables, frame, scan headers.
            kept = True
        if kept:
            pieces.keep(start, stop)
        elif marker in (0xE2, 0xEE):
            survey.blocks.add("other")
        if leading:
            if marker == 0xE0:
                insert_at = stop
            else:
                leading = False
        if end > size:
            break
        pos = end
        if marker == 0xDA:
            # The scan's entropy-coded data, up to the next marker: more
            # tables and scans in a progressive JPEG, or EOI.
            scanned = True
            following = _entropy_end(source, pos)
            pieces.keep(pos, following)
            pos = following

    if orientation is not None and orientation != 1:
        # [0, insert_at) is SOI and kept APP0s, all inside the first range.
        first = pieces.list[0]
        assert isinstance(first, Range)
        rest = pieces.list[1:]
        pieces.list = []
        pieces.keep(0, insert_at)
        pieces.add(_minimal_jpeg_app1(orientation))
        pieces.keep(insert_at, first.end)
        pieces.list.extend(rest)
    survey.all = None if pieces.is_whole(size) else pieces.list
    return survey


def _itxt_text_offset(data: bytes, keyword_end: int) -> Optional[int]:
    """Where an iTXt chunk's text starts in its data: after the keyword's
    NUL, the compression flag and method, and the NUL-ended language tag and
    translated keyword. None when the chunk does not hold them."""
    if keyword_end < 0 or keyword_end + 3 > len(data):
        return None
    language_end = data.find(b"\x00", keyword_end + 3)
    translated_end = -1 if language_end < 0 else data.find(b"\x00", language_end + 1)
    return None if translated_end < 0 else translated_end + 1


def _survey_png(source: _Source) -> Survey:
    size = source.size
    survey = Survey("png")
    pieces = _Pieces()
    pieces.keep(0, 8)
    pos = 8
    while pos < size:
        if pos + 8 > size:
            pieces.keep(pos, size)
            break
        head = source.read(pos, 8)
        length = struct.unpack_from(">I", head, 0)[0]
        if length > 0x7FFFFFFF:
            survey.problem = f"chunk length {length} at byte {pos}"
            return survey
        chunk_type = head[4:8]
        end = pos + 12 + length
        stop = min(end, size)
        data = Region(pos + 8, min(length, size - pos - 8))
        # A chunk the file cuts short has no CRC to keep right.
        chunk = data if end <= size else None
        if chunk_type == b"eXIf":
            survey.blocks.add("exif")
            survey.exif_blocks += 1
            if survey.exif is None:
                skip = 6 if source.read(data.start, 6).startswith(EXIF_HEADER) else 0
                survey.exif = Block(data.start + skip, max(0, data.length - skip), chunk)
                orientation = _chunk_orientation(source.read(pos + 8, min(length, MAX_EXIF_BYTES)))
                if orientation is not None and orientation != 1:
                    # In the place of the one it replaces.
                    pieces.add(_minimal_png_exif(orientation))
        elif chunk_type in (b"tEXt", b"zTXt", b"iTXt"):
            text = source.read(data.start, min(data.length, MAX_TEXT_BYTES))
            keyword_end = text.find(b"\x00")
            keyword = text[: len(text) if keyword_end < 0 else keyword_end].decode("latin-1")
            if chunk_type == b"iTXt" and keyword == XMP_KEYWORD:
                survey.blocks.add("xmp")
                text_at = _itxt_text_offset(text, keyword_end)
                if text_at is not None and text[keyword_end + 1] == 0:
                    survey.xmp.append(Block(data.start + text_at, data.length - text_at, chunk))
            else:
                survey.blocks.add("text")
                survey.texts.append((chunk_type.decode("latin-1"), data))
        elif chunk_type == b"tIME":
            survey.blocks.add("other")
        if chunk_type not in DROPPED_PNG_CHUNKS:
            pieces.keep(pos, stop)
        if end > size:
            break
        pos = end
        if chunk_type == b"IEND":
            if pos < size:
                survey.blocks.add("trailer")
            break
    survey.all = None if pieces.is_whole(size) else pieces.list
    return survey


def _survey_webp(source: _Source) -> Survey:
    size = source.size
    survey = Survey("webp")
    header = source.read(0, 12)
    riff_size = struct.unpack_from("<I", header, 4)[0]
    if riff_size < 4:
        survey.problem = f"RIFF size {riff_size}"
        return survey
    # Bytes after the RIFF's own end are not part of the image.
    riff_end = min(8 + riff_size, size)
    if 8 + riff_size < size:
        survey.blocks.add("trailer")
    pieces = _Pieces()
    # VP8X's flags byte, held as a placeholder until the end decides it.
    flags_placeholder = bytearray(1)
    flags: Optional[tuple[int, int]] = None
    exif_kept = False
    pos = 12
    while pos < riff_end:
        if pos + 8 > riff_end:
            pieces.keep(pos, riff_end)
            break
        head = source.read(pos, 8)
        fourcc = head[0:4]
        length = struct.unpack_from("<I", head, 4)[0]
        # Chunks are padded to an even size.
        end = pos + 8 + length + (length % 2)
        stop = min(end, riff_end)
        data = Region(pos + 8, min(length, riff_end - pos - 8))
        if fourcc == b"EXIF":
            survey.blocks.add("exif")
            survey.exif_blocks += 1
            if survey.exif is None:
                skip = 6 if source.read(data.start, 6).startswith(EXIF_HEADER) else 0
                survey.exif = Block(data.start + skip, max(0, data.length - skip), None)
                orientation = _chunk_orientation(source.read(pos + 8, min(length, MAX_EXIF_BYTES)))
                if orientation is not None and orientation != 1:
                    pieces.add(_minimal_webp_exif(orientation))
                    exif_kept = True
        elif fourcc == b"XMP ":
            survey.blocks.add("xmp")
            survey.xmp.append(Block(data.start, data.length, None))
        elif fourcc == b"VP8X" and pos == 12 and stop - pos >= 9:
            pieces.keep(pos, pos + 8)
            flags = (pos + 8, source.byte(pos + 8) or 0)
            pieces.add(flags_placeholder)
            pieces.keep(pos + 9, stop)
        else:
            pieces.keep(pos, stop)
        if end > riff_end:
            break
        pos = end

    written = sum(len(piece) if not isinstance(piece, Range) else piece.end - piece.start for piece in pieces.list)
    # The RIFF size moves by what was taken out or put in, so a file whose
    # size was off before is off by the same amount after.
    new_riff_size = riff_size + written - (riff_end - 12)
    if new_riff_size > 0xFFFFFFFF:
        survey.problem = f"RIFF size {riff_size}"
        return survey
    result = _Pieces()
    if new_riff_size == riff_size:
        result.keep(0, 12)
    else:
        result.add(header[0:4] + struct.pack("<I", new_riff_size) + header[8:12])
    for piece in pieces.list:
        if piece is flags_placeholder and flags is not None:
            at, old = flags
            # No XMP any more; EXIF only when the minimal block stayed.
            value = old & ~WEBP_XMP_FLAG & (0xFF if exif_kept else ~WEBP_EXIF_FLAG)
            # The same byte stays a range, so an untouched file stays whole.
            if value == old:
                result.keep(at, at + 1)
            else:
                result.add(bytes([value]))
        elif isinstance(piece, Range):
            result.keep(piece.start, piece.end)
        else:
            result.add(bytes(piece))
    survey.all = None if result.is_whole(size) else result.list
    return survey


def _survey(source: _Source) -> Survey:
    # The sniff the cloud's upload route does (detectImageContentType).
    if source.size < 12:
        return Survey(None)
    head = source.read(0, 12)
    if head[0:3] == b"\xff\xd8\xff":
        return _survey_jpeg(source)
    if head.startswith(PNG_SIGNATURE):
        return _survey_png(source)
    if head[0:4] == b"RIFF" and head[8:12] == b"WEBP":
        return _survey_webp(source)
    return Survey(None)


# ---------------------------------------------------------------------------
# EXIF: the TIFF structure inside an EXIF block
# ---------------------------------------------------------------------------

TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


@dataclass
class _Entry:
    tag: int
    type: int
    count: int
    value_at: int


class _Tiff:
    def __init__(self, data: bytes):
        self.data = data
        self.little = data[0:2] == b"II"
        self.order = "<" if self.little else ">"

    @staticmethod
    def open(data: bytes) -> Optional["_Tiff"]:
        if len(data) < 8 or data[0:2] not in (b"II", b"MM"):
            return None
        tiff = _Tiff(data)
        return tiff if tiff.u16(2) == 42 else None

    def _unpack(self, code: str, at: int) -> Any:
        return struct.unpack_from(self.order + code, self.data, at)[0]

    def u16(self, at: int) -> int:
        return self._unpack("H", at)

    def u32(self, at: int) -> int:
        return self._unpack("I", at)

    def ifd(self, offset: int) -> Optional[tuple[list[_Entry], int]]:
        """An IFD's entries (as many as the block holds) and the next IFD's offset."""
        if offset == 0 or offset + 2 > len(self.data):
            return None
        count = self.u16(offset)
        entries: list[_Entry] = []
        for index in range(count):
            at = offset + 2 + index * 12
            if at + 12 > len(self.data):
                break
            entries.append(_Entry(self.u16(at), self.u16(at + 2), self.u32(at + 4), at + 8))
        next_at = offset + 2 + count * 12
        return entries, (self.u32(next_at) if next_at + 4 <= len(self.data) else 0)

    def value_offset(self, entry: _Entry) -> Optional[int]:
        """Where an entry's value lies: in the entry when it fits, else at its offset."""
        size = TYPE_SIZES.get(entry.type, 0) * entry.count
        if size <= 4:
            return entry.value_at
        offset = self.u32(entry.value_at)
        return offset if offset + size <= len(self.data) else None

    def pointer(self, entry: Optional[_Entry]) -> Optional[int]:
        """The IFD an entry points to (a LONG or IFD of count 1), or None."""
        if entry is None or entry.type not in (4, 13) or entry.count != 1:
            return None
        return self.u32(entry.value_at)

    def number(self, kind: int, at: int) -> Optional[float]:
        if kind == 1:
            return self.data[at]
        if kind == 6:
            return self._unpack("b", at)
        if kind == 3:
            return self.u16(at)
        if kind == 8:
            return self._unpack("h", at)
        if kind == 4:
            return self.u32(at)
        if kind == 9:
            return self._unpack("i", at)
        if kind == 5:
            return _ratio(self.u32(at), self.u32(at + 4))
        if kind == 10:
            return _ratio(self._unpack("i", at), self._unpack("i", at + 4))
        if kind == 11:
            return _finite(self._unpack("f", at))
        return _finite(self._unpack("d", at))


def _finite(value: float) -> Optional[float]:
    # -0 is 0: JSON has no negative zero.
    if not math.isfinite(value):
        return None
    return 0 if value == 0 else value


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return None if denominator == 0 else _finite(numerator / denominator)


def _capped(text: str) -> str:
    """Cut to 256 characters (code points) and "…"."""
    return text[:MAX_STRING_LENGTH] + "…" if len(text) > MAX_STRING_LENGTH else text


def _ascii_string(data: bytes, encoding: str = "utf-8") -> str:
    """An ASCII value: to its first NUL, UTF-8 (bad bytes replaced), trailing whitespace off."""
    end = data.find(b"\x00")
    text = data if end < 0 else data[:end]
    decoded = text.decode("utf-8", "replace") if encoding == "utf-8" else text.decode("latin-1")
    return _capped(decoded.rstrip(" \t\n\r\x0b\x0c"))


def _undefined_value(data: bytes, count: int) -> str:
    """UNDEFINED bytes: text when every byte is printable ASCII, else their count."""
    trimmed = data.rstrip(b"\x00 ")
    if any(byte < 0x20 or byte > 0x7E for byte in trimmed):
        return f"({count} bytes)"
    return _capped(trimmed.decode("latin-1"))


def _field_value(tiff: _Tiff, entry: _Entry) -> Any:
    """An entry as the Metadata object shows it; ... (Ellipsis) for one that is skipped."""
    unit = TYPE_SIZES.get(entry.type)
    if unit is None or entry.count == 0:
        return ...
    if entry.tag == 0x927C:
        return f"({entry.count * unit} bytes)"
    if entry.type not in (2, 7) and entry.count > 16:
        return f"({entry.count} values)"
    at = tiff.value_offset(entry)
    if at is None:
        return ...
    if entry.type == 2:
        return _ascii_string(tiff.data[at:at + entry.count])
    if entry.type == 7:
        data = tiff.data[at:at + entry.count]
        if entry.tag == 0x9286 and data.startswith(USER_COMMENT_ASCII):
            return _ascii_string(data[len(USER_COMMENT_ASCII):])
        return _undefined_value(data, entry.count)
    values = [tiff.number(entry.type, at + index * unit) for index in range(entry.count)]
    return values[0] if entry.count == 1 else values


def _tag_name(table: dict[int, str], tag: int) -> str:
    return table.get(tag) or f"Tag 0x{tag:04X}"


def _valid_location(latitude: Optional[float], longitude: Optional[float]) -> bool:
    return (
        latitude is not None
        and longitude is not None
        and abs(latitude) <= 90
        and abs(longitude) <= 180
        # What a camera without a fix writes.
        and not (latitude == 0 and longitude == 0)
    )


def _gps_coordinate(tiff: _Tiff, entry: Optional[_Entry]) -> Optional[float]:
    """Degrees, minutes, seconds (RATIONAL 1 to 3 of them) as decimal degrees."""
    if entry is None or entry.type != 5 or entry.count < 1:
        return None
    at = tiff.value_offset(entry)
    if at is None:
        return None
    parts: list[float] = [0, 0, 0]
    for index in range(min(entry.count, 3)):
        part = _ratio(tiff.u32(at + index * 8), tiff.u32(at + index * 8 + 4))
        if part is None:
            return None
        parts[index] = part
    return _finite(parts[0] + parts[1] / 60 + parts[2] / 3600)


def _gps_ref(tiff: _Tiff, entry: Optional[_Entry]) -> str:
    if entry is None or entry.type != 2:
        return ""
    at = tiff.value_offset(entry)
    return "" if at is None else _ascii_string(tiff.data[at:at + entry.count])


def _signed(value: float, negative: bool) -> float:
    return -value if negative and value != 0 else value


def _gps_location(tiff: _Tiff, entries: list[_Entry]) -> Optional[dict[str, Any]]:
    by_tag: dict[int, _Entry] = {}
    for entry in entries:
        by_tag.setdefault(entry.tag, entry)
    latitude = _gps_coordinate(tiff, by_tag.get(0x0002))
    longitude = _gps_coordinate(tiff, by_tag.get(0x0004))
    if latitude is None or longitude is None:
        return None
    north = _signed(latitude, _gps_ref(tiff, by_tag.get(0x0001)) == "S")
    east = _signed(longitude, _gps_ref(tiff, by_tag.get(0x0003)) == "W")
    if not _valid_location(north, east):
        return None
    altitude: Optional[float] = None
    altitude_entry = by_tag.get(0x0006)
    if altitude_entry is not None and altitude_entry.type == 5 and altitude_entry.count >= 1:
        at = tiff.value_offset(altitude_entry)
        value = None if at is None else _ratio(tiff.u32(at), tiff.u32(at + 4))
        if value is not None:
            ref_entry = by_tag.get(0x0005)
            ref_at = tiff.value_offset(ref_entry) if ref_entry is not None and ref_entry.type == 1 and ref_entry.count >= 1 else None
            altitude = _signed(value, ref_at is not None and tiff.data[ref_at] == 1)
    return {"latitude": north, "longitude": east, "altitude": altitude}


def read_exif(data: bytes) -> tuple[list[dict[str, Any]], Optional[dict[str, Any]], bool]:
    """Every field of an EXIF block by group, its GPS location, and whether
    it holds nothing but the orientation."""
    tiff = _Tiff.open(data)
    if tiff is None:
        return [], None, False
    seen: set[int] = set()

    def ifd_at(offset: Optional[int]) -> Optional[tuple[list[_Entry], int]]:
        if offset is None or offset in seen:
            return None
        seen.add(offset)
        return tiff.ifd(offset)

    def first(found: Optional[tuple[list[_Entry], int]], tag: int) -> Optional[_Entry]:
        return next((entry for entry in found[0] if entry.tag == tag), None) if found else None

    image = ifd_at(tiff.u32(4))
    photo = ifd_at(tiff.pointer(first(image, 0x8769)))
    gps = ifd_at(tiff.pointer(first(image, 0x8825)))
    interop = ifd_at(tiff.pointer(first(photo, 0xA005)))
    thumbnail = ifd_at(image[1] if image and image[1] != 0 else None)
    groups = [
        ("Image", image, MAIN_TAG_NAMES),
        ("Photo", photo, MAIN_TAG_NAMES),
        ("Location", gps, GPS_TAG_NAMES),
        ("Interoperability", interop, INTEROP_TAG_NAMES),
        ("Thumbnail", thumbnail, MAIN_TAG_NAMES),
    ]
    fields: list[dict[str, Any]] = []
    for group, found, table in groups:
        for entry in found[0] if found else []:
            if len(fields) >= MAX_FIELDS:
                break
            if entry.tag in POINTER_TAGS:
                continue
            value = _field_value(tiff, entry)
            if value is not ...:
                fields.append({"group": group, "name": _tag_name(table, entry.tag), "value": value})
    location = _gps_location(tiff, gps[0]) if gps else None
    orientation_only = image is not None and len(image[0]) == 1 and image[0][0].tag == 0x0112 and image[1] == 0
    return fields, location, orientation_only


# ---------------------------------------------------------------------------
# XMP
# ---------------------------------------------------------------------------

_XMP_COORDINATE = re.compile(r"[ \t\r\n]*([0-9]+),([0-9]+(?:\.[0-9]+)?)(?:,([0-9]+(?:\.[0-9]+)?))?([NSEW])[ \t\r\n]*")
# A hostile packet cannot make the scan slow: at most this many exif:GPS
# occurrences are looked at, and a property must end within this many
# characters of where it starts.
MAX_XMP_PROPERTIES = 4096
MAX_XMP_PROPERTY_LENGTH = 65536
_XMP_SPACE = " \t\r\n"
_XMP_NAME_CHARACTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


def _is_xmp_space(character: Optional[str]) -> bool:
    return character is not None and character in _XMP_SPACE


@dataclass
class _XmpProperty:
    start: int
    end: int
    name: str
    value: Optional[str]


def _xmp_gps_properties(text: str) -> list[_XmpProperty]:
    """Every exif:GPS* property of an XMP packet (read as Latin-1, so an index
    is a byte offset), in order: an attribute `exif:GPSx="v"` or an element
    `<exif:GPSx>v</exif:GPSx>` (`value` None when it holds markup or is
    self-closing). The cloud's xmpGpsProperties, step for step."""
    properties: list[_XmpProperty] = []
    length = len(text)

    def char(at: int) -> Optional[str]:
        return text[at] if 0 <= at < length else None

    pos = 0
    for _looked in range(MAX_XMP_PROPERTIES):
        at = text.find("exif:GPS", pos)
        if at < 0:
            break
        pos = at + 1
        name_end = at + 8
        while char(name_end) in _XMP_NAME_CHARACTERS:
            name_end += 1
        name = text[at + 5:name_end]
        limit = min(length, at + MAX_XMP_PROPERTY_LENGTH)
        if at > 0 and text[at - 1] == "<":
            following = char(name_end)
            if following not in (">", "/") and not _is_xmp_space(following):
                continue
            tag_end = text.find(">", name_end, limit)
            if tag_end < 0:
                continue
            content_start = tag_end + 1
            if text[content_start - 2] == "/":
                properties.append(_XmpProperty(at - 1, content_start, name, None))
                pos = content_start
                continue
            close = f"</exif:{name}"
            search = content_start
            end = -1
            content_end = -1
            while search < limit:
                close_at = text.find(close, search, limit)
                if close_at < 0:
                    break
                after = close_at + len(close)
                while after < limit and text[after] in _XMP_SPACE:
                    after += 1
                if after < limit and text[after] == ">":
                    end = after + 1
                    content_end = close_at
                    break
                search = close_at + 1
            if end < 0:
                continue
            content = text[content_start:content_end]
            properties.append(_XmpProperty(at - 1, end, name, None if "<" in content else content))
            pos = end
            continue
        equals = name_end
        while _is_xmp_space(char(equals)):
            equals += 1
        if char(equals) != "=":
            continue
        quote_at = equals + 1
        while _is_xmp_space(char(quote_at)):
            quote_at += 1
        quote = char(quote_at)
        if quote is None or quote not in ('"', "'"):
            continue
        close_at = text.find(quote, quote_at + 1, limit)
        if close_at < 0:
            continue
        properties.append(_XmpProperty(at, close_at + 1, name, text[quote_at + 1:close_at]))
        pos = close_at + 1
    return properties


def _xmp_degrees(properties: list[_XmpProperty], name: str) -> Optional[float]:
    """"DDD,MM,SSk" or "DDD,MM.mmk" (k one of NSEW) as decimal degrees."""
    found = next((prop for prop in properties if prop.name == name and prop.value is not None), None)
    parsed = _XMP_COORDINATE.fullmatch(found.value or "") if found else None
    if parsed is None:
        return None
    value = _finite(float(parsed.group(1)) + float(parsed.group(2)) / 60 + float(parsed.group(3) or "0") / 3600)
    return None if value is None else _signed(value, parsed.group(4) in ("S", "W"))


def _xmp_location(packet: bytes) -> Optional[dict[str, Any]]:
    properties = _xmp_gps_properties(packet.decode("latin-1"))
    latitude = _xmp_degrees(properties, "GPSLatitude")
    longitude = _xmp_degrees(properties, "GPSLongitude")
    if not _valid_location(latitude, longitude):
        return None
    return {"latitude": latitude, "longitude": longitude, "altitude": None}


def blank_xmp_gps(packet: bytes) -> Optional[bytes]:
    """The packet with its GPS properties blanked (same length), or None when it has none."""
    properties = _xmp_gps_properties(packet.decode("latin-1"))
    if not properties:
        return None
    blanked = bytearray(packet)
    for prop in properties:
        blanked[prop.start:prop.end] = b" " * (prop.end - prop.start)
    return bytes(blanked)


# ---------------------------------------------------------------------------
# Location removal: the GPS IFD cut out of IFD0
# ---------------------------------------------------------------------------


def cut_exif_gps(data: bytes) -> Optional[bytes]:
    """The EXIF block with every GPS pointer cut out of IFD0 (later entries
    and the next-IFD offset move up, the freed bytes are zero) and each GPS
    IFD, with the values its entries point to, zeroed. Same length; None
    when IFD0 points to no GPS IFD."""
    tiff = _Tiff.open(data)
    if tiff is None:
        return None
    size = len(data)
    ifd0 = tiff.u32(4)
    if ifd0 == 0 or ifd0 + 2 > size:
        return None
    count = tiff.u16(ifd0)
    ifd_end = ifd0 + 2 + count * 12 + 4
    if ifd_end > size:
        return None
    entries = [ifd0 + 2 + index * 12 for index in range(count)]
    gps_entries = [at for at in entries if tiff.u16(at) == 0x8825]
    if not gps_entries:
        return None
    out = bytearray(data)
    # The GPS IFDs and their values first, read from the original. Only a
    # real pointer (a LONG or IFD, count 1) is followed.
    for at in gps_entries:
        kind = tiff.u16(at + 2)
        gps = tiff.u32(at + 8) if kind in (4, 13) and tiff.u32(at + 4) == 1 else 0
        if gps == 0 or gps + 2 > size:
            continue
        gps_count = tiff.u16(gps)
        for index in range(gps_count):
            entry_at = gps + 2 + index * 12
            if entry_at + 12 > size:
                break
            value_size = TYPE_SIZES.get(tiff.u16(entry_at + 2), 0) * tiff.u32(entry_at + 4)
            if value_size > 4:
                offset = tiff.u32(entry_at + 8)
                if offset + value_size <= size:
                    out[offset:offset + value_size] = bytes(value_size)
        zero_end = min(size, gps + 2 + gps_count * 12 + 4)
        out[gps:zero_end] = bytes(zero_end - gps)
    # Then IFD0 without them, from the original's bytes.
    kept = [at for at in entries if tiff.u16(at) != 0x8825]
    out[ifd0:ifd0 + 2] = struct.pack(tiff.order + "H", len(kept))
    write = ifd0 + 2
    for at in kept:
        out[write:write + 12] = data[at:at + 12]
        write += 12
    out[write:write + 4] = data[ifd_end - 4:ifd_end]
    out[write + 4:ifd_end] = bytes(ifd_end - write - 4)
    return bytes(out)


# ---------------------------------------------------------------------------
# Reading and rewriting
# ---------------------------------------------------------------------------


def _read_metadata(source: _Source, survey: Survey) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    location: Optional[dict[str, Any]] = None
    blocks = set(survey.blocks)
    if survey.exif is not None:
        exif_fields, location, orientation_only = read_exif(
            source.read(survey.exif.start, min(survey.exif.length, MAX_BLOCK_BYTES))
        )
        fields.extend(exif_fields)
        # An EXIF block that only turns the photo is what "remove all" keeps.
        if orientation_only and survey.exif_blocks == 1:
            blocks.discard("exif")
    for kind, region in survey.texts:
        if len(fields) >= MAX_FIELDS:
            break
        data = source.read(region.start, min(region.length, MAX_TEXT_BYTES))
        keyword_end = data.find(b"\x00")
        name = _capped(data[: len(data) if keyword_end < 0 else keyword_end].decode("latin-1"))
        value = ""
        if kind == "zTXt":
            value = "(compressed)"
        elif keyword_end >= 0 and kind == "tEXt":
            value = _ascii_string(data[keyword_end + 1:], "latin-1")
        elif keyword_end >= 0 and keyword_end + 1 < len(data) and data[keyword_end + 1] == 1:
            value = "(compressed)"
        elif keyword_end >= 0:
            text_at = _itxt_text_offset(data, keyword_end)
            value = "" if text_at is None else _ascii_string(data[text_at:])
        fields.append({"group": "Text", "name": name, "value": value})
    if location is None:
        for packet in survey.xmp:
            location = _xmp_location(source.read(packet.start, min(packet.length, MAX_BLOCK_BYTES)))
            if location is not None:
                break
    return {"location": location, "fields": fields, "blocks": [block for block in BLOCK_ORDER if block in blocks]}


def _location_pieces(source: _Source, survey: Survey) -> Optional[list[Piece]]:
    """"remove location": the patched blocks (PNG chunks with their new CRC) as pieces."""
    patches: list[tuple[int, bytes]] = []

    def patch(block: Block, edited: Optional[bytes]) -> None:
        if edited is None:
            return
        if block.chunk is None:
            patches.append((block.start, edited))
            return
        # The whole chunk data, edited, and its CRC over the type and data.
        chunk = block.chunk
        data = bytearray(source.read(chunk.start, chunk.length))
        offset = block.start - chunk.start
        data[offset:offset + len(edited)] = edited
        chunk_type = source.read(chunk.start - 4, 4)
        patches.append((chunk.start, bytes(data) + _crc(chunk_type + bytes(data))))

    def fits(block: Block) -> bool:
        return block.length <= MAX_BLOCK_BYTES and (block.chunk is None or block.chunk.length <= MAX_BLOCK_BYTES)

    if survey.exif is not None and fits(survey.exif):
        patch(survey.exif, cut_exif_gps(source.read(survey.exif.start, survey.exif.length)))
    for packet in survey.xmp:
        if fits(packet):
            patch(packet, blank_xmp_gps(source.read(packet.start, packet.length)))
    if not patches:
        return None
    patches.sort(key=lambda item: item[0])
    pieces = _Pieces()
    at = 0
    for start, data in patches:
        pieces.keep(at, start)
        pieces.add(data)
        at = start + len(data)
    pieces.keep(at, source.size)
    return pieces.list


def _bytes_reader(data: bytes) -> Reader:
    view = memoryview(data)
    return lambda offset, length: bytes(view[offset:offset + length])


def file_reader(handle: BinaryIO) -> Reader:
    """Range reads from an open file: what a photo on disk is read through."""

    def read(offset: int, length: int) -> bytes:
        handle.seek(offset)
        return handle.read(length)

    return read


def read_photo_metadata(read: Reader, size: int) -> dict[str, Any]:
    """What a photo carries: the Metadata object of docs/photos.md."""
    source = _Source(read, size)
    return _read_metadata(source, _survey(source))


def read_photo_metadata_bytes(data: bytes) -> dict[str, Any]:
    return read_photo_metadata(_bytes_reader(data), len(data))


def _writes_input(source: _Source, pieces: list[Piece]) -> bool:
    """Whether the pieces write the input back byte for byte: "remove all"
    on a photo it already cleaned drops the minimal EXIF block and puts the
    same one back."""
    at = 0
    for piece in pieces:
        if isinstance(piece, Range):
            if piece.start != at:
                return False
            at = piece.end
        else:
            if bytes(piece) != source.read(at, len(piece)):
                return False
            at += len(piece)
    return at == source.size


def plan_removal(read: Reader, size: int, removal: str) -> tuple[Optional[str], Optional[list[Piece]], Optional[str]]:
    """(format, pieces or None when nothing changes, problem) for "location" or "all"."""
    if removal not in REMOVALS:
        raise ValueError(f"remove must be one of {', '.join(REMOVALS)}")
    source = _Source(read, size)
    survey = _survey(source)
    pieces = survey.all if removal == "all" else _location_pieces(source, survey)
    if pieces is not None and _writes_input(source, pieces):
        pieces = None
    return survey.format, pieces, survey.problem


def remove_photo_metadata(data: bytes, removal: str) -> RewrittenPhoto:
    """The photo without its location, or without all its metadata: the same
    bytes when nothing had to go (not an image this knows, already clean, or
    "all" on a file that cannot be followed)."""
    view = memoryview(data)
    file_format, pieces, problem = plan_removal(_bytes_reader(data), len(data), removal)
    if pieces is None:
        return RewrittenPhoto(data=data, changed=False, format=file_format, problem=problem)
    # One allocation for the result: the kept ranges are views of the input.
    out = b"".join(view[piece.start:piece.end] if isinstance(piece, Range) else piece for piece in pieces)
    return RewrittenPhoto(data=out, changed=True, format=file_format, problem=problem)


def strip_photo_metadata(data: bytes) -> RewrittenPhoto:
    """`remove="all"`."""
    return remove_photo_metadata(data, "all")
