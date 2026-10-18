"""Location and camera metadata taken out of a photo before it is stored
(docs/photos.md "POST /api/photos/upload"). A phone's JPEG carries where it
was taken (EXIF GPS), the camera's serial number, timestamps, XMP and
sometimes a whole "motion photo" video after the picture; a share link would
hand all of it to anyone who has the link. The stored object, its hash (the
object key), its size and its thumbnail all come from the result.

Lossless and byte-level: no pixel is decoded or re-encoded, segments and
chunks are dropped or kept as they are.

- JPEG: APP0 (JFIF), APP2 ICC_PROFILE, APP14 Adobe and every structural
  segment stay; APP1 (EXIF, XMP), the other APPn, COM and everything after
  the primary image's EOI (MPF images, motion-photo videos) go.
- PNG: eXIf, tEXt, zTXt, iTXt and tIME go, and whatever follows IEND.
- WebP: the EXIF and XMP chunks go, the RIFF size and the VP8X flags follow.
- GIF and anything else (the backend stores any file): untouched.

An EXIF orientation other than 1 survives as a minimal EXIF block (one IFD0
entry, big-endian), so the photo still shows upright everywhere. A file whose
structure cannot be followed is stored as it came (never worse than before
this existed) and the caller logs it.

The cloud's cloud/apps/auth-web/src/lib/photos/metadata.ts is the same
procedure, rule for rule: both planes replay docs/photo-metadata-fixtures.json
and must write byte-identical files. Change one, change both, re-record the
corpus (tools/generate_photo_metadata_fixtures.py).

The photo is read at offsets through `read(offset, length)` (segment lengths
skip payloads unread, entropy data is scanned in chunks), so the procedure
does not need the whole file in memory; the backend's uploads are bytes
already (app/utils/photos.py take_upload).
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from typing import Callable, Optional, Union

# The most of an EXIF block read for its orientation: what a JPEG's APP1
# segment can hold. IFD0 sits at its start in every camera's file.
MAX_EXIF_BYTES = 65536
WINDOW_BYTES = 64 * 1024
SCAN_CHUNK_BYTES = 1024 * 1024

EXIF_HEADER = b"Exif\x00\x00"
ICC_HEADER = b"ICC_PROFILE\x00"
ADOBE_HEADER = b"Adobe"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DROPPED_PNG_CHUNKS = {b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME"}
WEBP_EXIF_FLAG = 0x08
WEBP_XMP_FLAG = 0x04

Reader = Callable[[int, int], bytes]


@dataclass
class Range:
    """A stretch of the input kept as it is."""

    start: int
    end: int


Piece = Union[Range, bytes, bytearray]


@dataclass
class Plan:
    format: Optional[str]
    # None: keep the file as it came.
    pieces: Optional[list[Piece]]
    problem: Optional[str] = None


@dataclass
class StrippedPhoto:
    data: bytes
    changed: bool
    format: Optional[str]
    # Why a JPEG, PNG or WebP was kept as it came (it could not be parsed).
    problem: Optional[str]


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


def _minimal_png_exif(orientation: int) -> bytes:
    body = b"eXIf" + minimal_exif_tiff(orientation)
    return struct.pack(">I", len(body) - 4) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


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


def _plan_jpeg(source: _Source) -> Plan:
    size = source.size
    pieces = _Pieces()
    pieces.keep(0, 2)
    # The minimal APP1 goes after SOI and the APP0 segments right behind it.
    insert_at = 2
    leading = True
    exif_seen = False
    orientation: Optional[int] = None
    scanned = False
    pos = 2
    while pos < size:
        start = pos
        if source.byte(pos) != 0xFF:
            return Plan("jpeg", None, f"no marker at byte {pos}")
        # Any number of 0xff fill bytes may precede a marker.
        at = pos + 1
        while source.byte(at) == 0xFF:
            at += 1
        marker = source.byte(at)
        if marker is None:
            pieces.keep(start, size)
            break
        if marker == 0x00:
            return Plan("jpeg", None, f"no marker at byte {pos}")
        if marker == 0xD9:
            # The primary image's end: whatever follows (MPF images, a motion
            # photo's video) goes with the rest of the metadata.
            pieces.keep(start, at + 1)
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
            return Plan("jpeg", None, f"segment length {length} at byte {pos}")
        payload = at + 3
        end = at + 1 + length
        stop = min(end, size)
        if marker == 0xE1:
            kept = False
            if not exif_seen and not scanned:
                head = source.read(payload, stop - payload)
                if head.startswith(EXIF_HEADER):
                    exif_seen = True
                    orientation = tiff_orientation(head[6:])
        elif marker == 0xE2:
            kept = source.read(payload, len(ICC_HEADER)) == ICC_HEADER
        elif marker == 0xEE:
            kept = source.read(payload, len(ADOBE_HEADER)) == ADOBE_HEADER
        elif 0xE3 <= marker <= 0xEF or marker == 0xFE:
            kept = False
        else:
            # APP0 and every structural segment: tables, frame, scan headers.
            kept = True
        if kept:
            pieces.keep(start, stop)
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
    return Plan("jpeg", None) if pieces.is_whole(size) else Plan("jpeg", pieces.list)


def _plan_png(source: _Source) -> Plan:
    size = source.size
    pieces = _Pieces()
    pieces.keep(0, 8)
    exif_seen = False
    pos = 8
    while pos < size:
        if pos + 8 > size:
            pieces.keep(pos, size)
            break
        head = source.read(pos, 8)
        length = struct.unpack_from(">I", head, 0)[0]
        if length > 0x7FFFFFFF:
            return Plan("png", None, f"chunk length {length} at byte {pos}")
        chunk_type = head[4:8]
        end = pos + 12 + length
        stop = min(end, size)
        if chunk_type == b"eXIf" and not exif_seen:
            exif_seen = True
            orientation = _chunk_orientation(source.read(pos + 8, min(length, MAX_EXIF_BYTES)))
            if orientation is not None and orientation != 1:
                # In the place of the one it replaces.
                pieces.add(_minimal_png_exif(orientation))
        if chunk_type not in DROPPED_PNG_CHUNKS:
            pieces.keep(pos, stop)
        if end > size or chunk_type == b"IEND":
            break
        pos = end
    return Plan("png", None) if pieces.is_whole(size) else Plan("png", pieces.list)


def _plan_webp(source: _Source) -> Plan:
    size = source.size
    header = source.read(0, 12)
    riff_size = struct.unpack_from("<I", header, 4)[0]
    if riff_size < 4:
        return Plan("webp", None, f"RIFF size {riff_size}")
    # Bytes after the RIFF's own end are not part of the image.
    riff_end = min(8 + riff_size, size)
    pieces = _Pieces()
    # VP8X's flags byte, held as a placeholder until the end decides it.
    flags_placeholder = bytearray(1)
    flags: Optional[tuple[int, int]] = None
    exif_seen = False
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
        if fourcc == b"EXIF":
            if not exif_seen:
                exif_seen = True
                orientation = _chunk_orientation(source.read(pos + 8, min(length, MAX_EXIF_BYTES)))
                if orientation is not None and orientation != 1:
                    pieces.add(_minimal_webp_exif(orientation))
                    exif_kept = True
        elif fourcc == b"XMP ":
            pass  # Dropped.
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
        return Plan("webp", None, f"RIFF size {riff_size}")
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
    return Plan("webp", None) if result.is_whole(size) else Plan("webp", result.list)


def plan_strip(read: Reader, size: int) -> Plan:
    """What to write in place of the file `read` reads: its pieces, or None
    to keep it as it came."""
    source = _Source(read, size)
    # The sniff the cloud's upload route does (detectImageContentType).
    if size < 12:
        return Plan(None, None)
    head = source.read(0, 12)
    if head[0:3] == b"\xff\xd8\xff":
        return _plan_jpeg(source)
    if head.startswith(PNG_SIGNATURE):
        return _plan_png(source)
    if head[0:4] == b"RIFF" and head[8:12] == b"WEBP":
        return _plan_webp(source)
    return Plan(None, None)


def strip_photo_metadata(data: bytes) -> StrippedPhoto:
    """The photo without its metadata: the same bytes when nothing had to go
    (not an image this knows, already clean, or not parseable)."""
    view = memoryview(data)
    planned = plan_strip(lambda offset, length: bytes(view[offset:offset + length]), len(data))
    if planned.pieces is None:
        return StrippedPhoto(data=data, changed=False, format=planned.format, problem=planned.problem)
    # One allocation for the result: the kept ranges are views of the input.
    out = b"".join(view[piece.start:piece.end] if isinstance(piece, Range) else piece for piece in planned.pieces)
    return StrippedPhoto(data=out, changed=True, format=planned.format, problem=None)
