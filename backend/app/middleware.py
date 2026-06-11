
import os
import zlib
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# Cap the decompressed size of an incoming gzip body. A few KB of gzip can
# expand to gigabytes ("zip bomb"); this path is reachable on log ingestion, so
# decompress incrementally and abort once the limit is exceeded.
MAX_DECOMPRESSED_BODY = int(os.environ.get("MAX_DECOMPRESSED_BODY", str(32 * 1024 * 1024)))


def _bounded_gunzip(raw_body: bytes, limit: int) -> bytes | None:
    # 16 + MAX_WBITS lets zlib auto-detect the gzip header. Decompress in bounded
    # output slices so a bomb is caught before it materializes in memory.
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    chunks: list[bytes] = []
    total = 0
    data = raw_body
    while data:
        out = decompressor.decompress(data, 65536)
        total += len(out)
        if total > limit:
            return None
        chunks.append(out)
        data = decompressor.unconsumed_tail
    tail = decompressor.flush()
    total += len(tail)
    if total > limit:
        return None
    chunks.append(tail)
    return b"".join(chunks)


class GzipRequestMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.headers.get("content-encoding") == "gzip":
            # Read the raw gzipped body
            raw_body = await request.body()

            # Decompress with a hard size cap
            from starlette.responses import Response
            try:
                decompressed_body = _bounded_gunzip(raw_body, MAX_DECOMPRESSED_BODY)
            except (OSError, zlib.error):
                return Response("Invalid gzipped data", status_code=400)
            if decompressed_body is None:
                return Response("Decompressed body too large", status_code=413)

            # Remove content-encoding header and update content-length
            new_headers = [
                (name, value) for (name, value) in request.scope['headers']
                if name.lower() != b'content-encoding'
            ]
            new_headers = [
                (b'content-length', str(len(decompressed_body)).encode('utf-8'))
            ] + new_headers
            request.scope['headers'] = new_headers

            # Monkey-patch request._body so that request.json() and request.body() return the decompressed data
            request._body = decompressed_body

        response = await call_next(request)
        return response
