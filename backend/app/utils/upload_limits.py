"""Caps for bodies that end up in memory: multipart uploads, downloads the
backend makes on a user's behalf, and members read out of a zip."""
import zipfile

import httpx
from fastapi import HTTPException, Request, UploadFile

MAX_ASSET_UPLOAD_BYTES = 64 * 1024 * 1024
# A template zip (template.json + scenes.json + a cover image), uploaded or
# fetched from a pasted URL — and each member unpacked out of it. A scene
# graph is well under a megabyte; the caps leave room for a large cover.
MAX_TEMPLATE_ZIP_BYTES = 32 * 1024 * 1024
MAX_TEMPLATE_MEMBER_BYTES = 16 * 1024 * 1024
UPLOAD_READ_CHUNK_BYTES = 1024 * 1024
# Boundaries, part headers and the other form fields around the file.
MULTIPART_OVERHEAD_BYTES = 64 * 1024


def reject_oversized_content_length(request: Request, max_bytes: int) -> None:
    """413 on the declared size, before the multipart body is read at all."""
    content_length = request.headers.get("content-length") or ""
    if content_length.isdigit() and int(content_length) > max_bytes + MULTIPART_OVERHEAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded file too large")


async def read_upload_limited(file: UploadFile, max_bytes: int) -> bytes:
    """Read an upload in chunks and stop as soon as it exceeds `max_bytes`, so
    a body that lies about (or omits) Content-Length still cannot buffer more
    than the cap."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(UPLOAD_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail="Uploaded file too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def fetch_body_limited(client: httpx.AsyncClient, url: str, max_bytes: int, **kwargs) -> bytes:
    """GET `url` streaming, refusing bodies over `max_bytes` — on the declared
    Content-Length first, then on what actually arrives (a server can omit or
    understate the header)."""
    async with client.stream("GET", url, **kwargs) as response:
        response.raise_for_status()
        declared = response.headers.get("content-length") or ""
        if declared.isdigit() and int(declared) > max_bytes:
            raise HTTPException(status_code=413, detail="Downloaded file too large")
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail="Downloaded file too large")
            chunks.append(chunk)
    return b"".join(chunks)


def read_zip_member_limited(zip_file: zipfile.ZipFile, name: str, max_bytes: int) -> bytes:
    """`zip_file.read(name)` that refuses members over `max_bytes`: on the
    size the central directory declares, then on what actually inflates (the
    directory can lie), read in bounded chunks so a decompression bomb never
    gets to expand in one go."""
    info = zip_file.getinfo(name)
    if info.file_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"{name} in the zip is too large")
    chunks: list[bytes] = []
    total = 0
    with zip_file.open(info) as member:
        while True:
            chunk = member.read(UPLOAD_READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail=f"{name} in the zip is too large")
            chunks.append(chunk)
    return b"".join(chunks)
