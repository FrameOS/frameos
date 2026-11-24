"""Headers every answer of this backend carries.

- `X-Content-Type-Options: nosniff` on everything: a browser takes the type
  a response says, and never runs as script or style what was served as
  something else (an uploaded asset, a frame's file).
- Who may show the app in a frame, on the HTML pages: this backend itself
  (the local scenes page frames the editor bundle) and the FrameOS Cloud it
  is set up for or linked to (the cloud's workspace opens a linked backend
  in a frame), nobody else, so another site cannot lay the app under its
  own page and steer the owner's clicks. Not under Home Assistant ingress:
  there Home Assistant's own page frames the app, from its own address.
"""
from __future__ import annotations

import time
from urllib.parse import urlparse

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import config as app_config

_ANCESTORS_TTL_SECONDS = 30.0
_ancestors_cache: tuple[float, str] | None = None


def _origin(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def frame_ancestors() -> str:
    """The `frame-ancestors` source list: 'self' and the cloud provider's
    origin (the configured default and the one this install is linked to).
    Read from the database at most every 30 s."""
    global _ancestors_cache
    now = time.monotonic()
    if _ancestors_cache is not None and now - _ancestors_cache[0] < _ANCESTORS_TTL_SECONDS:
        return _ancestors_cache[1]
    sources = ["'self'"]
    try:
        from app.database import SessionLocal
        from app.models.cloud import current_cloud_backend_link
        from app.utils.cloud_link import default_cloud_provider_url

        candidates = [default_cloud_provider_url()]
        db = SessionLocal()
        try:
            link = current_cloud_backend_link(db)
            candidates.append(link.provider_url if link is not None else None)
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - a header must never fail a page
        candidates = []
    for candidate in candidates:
        origin = _origin(candidate)
        if origin and origin not in sources:
            sources.append(origin)
    value = " ".join(sources)
    _ancestors_cache = (now, value)
    return value


def forget_frame_ancestors() -> None:
    global _ancestors_cache
    _ancestors_cache = None


class ResponseHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "x-content-type-options" not in headers:
                    headers["X-Content-Type-Options"] = "nosniff"
                content_type = headers.get("content-type", "")
                if (
                    content_type.startswith("text/html")
                    and app_config.config.HASSIO_RUN_MODE != "ingress"
                    and "content-security-policy" not in headers
                ):
                    headers["Content-Security-Policy"] = f"frame-ancestors {frame_ancestors()}"
            await send(message)

        await self.app(scope, receive, send_with_headers)
