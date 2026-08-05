"""In-place personalization of prebuilt SD images via the setup-blob placeholder.

The Python sibling of the cloud's in-browser frameos-cloud.txt patcher
(cloud-frontend/src/lib/sd-image-patch.ts), for the SELF-HOSTED backend's
bigger payload: release images ship /boot/frameos-setup.bin as a fixed-size
all-comments region (setup_json_reset.render_setup_blob_placeholder), and
this module finds that region in the raw .img and overwrites it in place —
no mtools, no debugfs, no docker, no partition parsing. The FAT metadata
never changes because the file keeps its exact size.

The payload is a gzipped POSIX tar of the /boot/frameos-* personalization
files; busybox `gunzip | tar -x` unpacks it in the first-boot script.
"""
from __future__ import annotations

import gzip
import io
import mmap
import tarfile
from pathlib import Path

from app.tasks.setup_json_reset import (
    SETUP_BLOB_MAGIC,
    SETUP_BLOB_MEMBERS,
    SETUP_BLOB_PLACEHOLDER_SIZE,
    render_setup_blob_region,
)

# The magic must sit inside the FAT boot partition, which starts within the
# first few MiB of the image; 64 MiB leaves generous headroom for partition
# table changes without scanning gigabytes of rootfs.
DEFAULT_SEARCH_LIMIT = 64 * 1024 * 1024

_MAGIC_BYTES = (SETUP_BLOB_MAGIC + "\n").encode("ascii")


def build_setup_blob_payload(boot_files: dict[str, bytes]) -> bytes:
    """Gzipped tar of the given /boot personalization files.

    Only SETUP_BLOB_MEMBERS names are accepted — the on-device extractor
    installs exactly that allow-list, so anything else would be dead bytes.
    Deterministic output (fixed mtimes/owners), so identical inputs produce
    identical images.
    """
    for name in boot_files:
        if name not in SETUP_BLOB_MEMBERS:
            raise ValueError(f"{name} is not an allowed setup blob member")
    buffer = io.BytesIO()
    # mtime=0 keeps the gzip header deterministic.
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name in SETUP_BLOB_MEMBERS:
                content = boot_files.get(name)
                if content is None:
                    continue
                info = tarfile.TarInfo(name=name)
                info.size = len(content)
                info.mode = 0o600
                info.mtime = 0
                tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def _region_is_pristine(region: memoryview) -> bool:
    """True when the bytes after the magic look like the untouched placeholder.

    Mirrors the browser patcher's check: ASCII only, every line starting with
    '#'. Anything else is a decoy occurrence of the magic (or an already
    personalized image) and must not be overwritten.
    """
    at_line_start = False  # the magic line's own newline starts the first line
    for byte in region:
        if byte == 0x0A:
            at_line_start = True
            continue
        if at_line_start and byte != 0x23:  # '#'
            return False
        at_line_start = False
        if byte < 0x09 or byte > 0x7E:
            return False
    return True


def find_setup_blob_region(
    image_path: Path, *, search_limit: int = DEFAULT_SEARCH_LIMIT
) -> int | None:
    """Byte offset of the pristine placeholder region in the raw image, or None."""
    file_size = image_path.stat().st_size
    if file_size < len(_MAGIC_BYTES):
        return None
    with image_path.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
            limit = min(file_size, search_limit)
            position = 0
            while True:
                offset = mapped.find(_MAGIC_BYTES, position, limit)
                if offset < 0:
                    return None
                if offset + SETUP_BLOB_PLACEHOLDER_SIZE > file_size:
                    return None
                # A plain bytes copy (8 MiB) rather than a memoryview: a live
                # view into the mmap would block its close with BufferError.
                region = mapped[
                    offset + len(_MAGIC_BYTES) : offset + SETUP_BLOB_PLACEHOLDER_SIZE
                ]
                if _region_is_pristine(memoryview(region)):
                    return offset
                # A decoy (e.g. the magic quoted inside some other file):
                # keep scanning one byte later, like the browser patcher.
                position = offset + 1


def patch_setup_blob_into_image(
    image_path: Path,
    payload: bytes,
    *,
    search_limit: int = DEFAULT_SEARCH_LIMIT,
) -> bool:
    """Overwrite the placeholder region in the raw .img with the payload.

    Returns False when the image carries no pristine placeholder (an older
    release) — callers fall back to server-side partition patching. Raises
    ValueError when the payload cannot fit the region.
    """
    region = render_setup_blob_region(payload)
    offset = find_setup_blob_region(image_path, search_limit=search_limit)
    if offset is None:
        return False
    with image_path.open("r+b") as handle:
        handle.seek(offset)
        handle.write(region)
    return True
