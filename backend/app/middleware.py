
import gzip
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

class GzipRequestMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.headers.get("content-encoding") == "gzip":
            # Read the raw gzipped body
            raw_body = await request.body()

            # Decompress
            try:
                decompressed_body = gzip.decompress(raw_body)
            except OSError:
                from starlette.responses import Response
                return Response("Invalid gzipped data", status_code=400)

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
