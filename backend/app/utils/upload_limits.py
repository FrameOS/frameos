"""Caps for multipart uploads that end up in memory or in a LargeBinary column."""
from fastapi import HTTPException, Request, UploadFile

MAX_ASSET_UPLOAD_BYTES = 64 * 1024 * 1024
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
