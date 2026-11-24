
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
            from starlette.responses import Response

            # Refuse on the declared size before buffering anything: the
            # compressed body cannot usefully be larger than the decompressed cap.
            content_length = request.headers.get("content-length") or ""
            if content_length.isdigit() and int(content_length) > MAX_DECOMPRESSED_BODY:
                return Response("Request body too large", status_code=413)

            # Read the raw gzipped body
            raw_body = await request.body()
            if len(raw_body) > MAX_DECOMPRESSED_BODY:
                return Response("Request body too large", status_code=413)

            # Decompress with a hard size cap
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


class BodyCeilingMiddleware:
    """A ceiling on the bodies of the routes anyone can call before signing
    in. FastAPI reads a JSON or form body whole before the route (or any of
    its dependencies) runs, so a route cannot refuse a large one itself: the
    login and signup forms are a few hundred bytes, and without this each
    request could make the backend buffer and parse megabytes for a caller
    with no credential at all. Pure ASGI: the declared length is refused at
    once; otherwise the body is read here up to the ceiling (it is small by
    definition) and handed on, or refused the moment it passes it."""

    def __init__(self, app, limits: dict[str, int]) -> None:
        self.app = app
        self.limits = limits

    async def __call__(self, scope, receive, send) -> None:
        limit = self.limits.get(scope.get("path", "")) if scope["type"] == "http" else None
        if limit is None or scope.get("method", "GET").upper() in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers") or []:
            if name.lower() == b"content-length" and value.strip().isdigit() and int(value) > limit:
                await self._refuse(send)
                return

        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                # The client went away: nothing to answer.
                return
            chunk = message.get("body") or b""
            total += len(chunk)
            if total > limit:
                await self._refuse(send)
                return
            chunks.append(chunk)
            if not message.get("more_body"):
                break

        body = b"".join(chunks)
        handed = False

        async def replay():
            nonlocal handed
            if not handed:
                handed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _refuse(send) -> None:
        body = b'{"detail":"Request body too large"}'
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
