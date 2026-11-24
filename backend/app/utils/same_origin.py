"""Is this browser request from one of this backend's own pages?

Two callers: the WebSocket handshake (app/api/auth.py) and the guard below,
which stands in front of every cookie-authenticated mutation.

`SameSite=Lax` on the session cookie stops a cross-SITE page; it does not
stop a same-site one (another port on the same host, a sibling subdomain),
whose POST carries the cookie like any other. And a route that reads its
body itself, takes multipart or takes no body at all needs no preflight, so
a page there could deploy, reboot or call an MCP tool as the signed-in
owner. The browser says where a request came from in headers page script
cannot set; this reads them.
"""
from __future__ import annotations

from typing import Mapping
from urllib.parse import urlparse

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app import config as app_config
from app.utils.request_ip import peer_is_trusted_proxy
from app.utils.session_cookie import SESSION_COOKIE_NAME

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def hosts_match(origin_host: str, candidate: str) -> bool:
    """host[:port] equality, case-insensitive, with the default ports the
    browser leaves off its Origin (`https://x` vs `Host: x:443`) treated as
    absent on both sides."""
    def normalize(value: str) -> str:
        value = value.strip().lower()
        for default in (":443", ":80"):
            if value.endswith(default):
                value = value[: -len(default)]
        return value

    return bool(candidate) and normalize(origin_host) == normalize(candidate)


def origin_is_ours(origin: str, headers: Mapping[str, str], peer: str | None) -> bool:
    """Whether `origin` (an Origin header's value) is the address the browser
    dialled this backend at.

    That address is `Host`, or — behind a proxy that rewrites `Host` to the
    upstream (nginx without `proxy_set_header Host $host`) —
    `X-Forwarded-Host`, honoured from trusted proxy peers only
    (app/utils/request_ip.py). A configured `FRAMEOS_PUBLIC_URL` is always an
    accepted origin. Compared as host:port, scheme ignored: a TLS-terminating
    proxy changes the scheme the browser sees, never the host it dialled."""
    try:
        origin_host = urlparse(origin).netloc
    except ValueError:
        return False
    if not origin_host:
        return False
    candidates = [headers.get("host", "")]
    if peer_is_trusted_proxy(peer):
        candidates.append(headers.get("x-forwarded-host", "").split(",", 1)[0])
    public_url = (app_config.config.FRAMEOS_PUBLIC_URL or "").strip()
    if public_url:
        try:
            candidates.append(urlparse(public_url).netloc)
        except ValueError:
            pass
    return any(hosts_match(origin_host, candidate) for candidate in candidates)


def _has_session_cookie(cookie_header: str) -> bool:
    return any(part.strip().startswith(f"{SESSION_COOKIE_NAME}=") for part in cookie_header.split(";"))


def cross_site_mutation(method: str, headers: Mapping[str, str], peer: str | None) -> bool:
    """True for a request that changes something, rides the session cookie,
    and that the browser says another origin's page started.

    Only the cookie is ambient. A bearer (a login JWT, an API token, a
    frame's key) is a header no cross-origin page can add without a
    preflight this backend never answers, so those callers — scripts, the
    MCP clients, the iOS app, frames — are not asked anything. Neither is a
    client that sends no `Origin` and no `Sec-Fetch-Site` at all: no browser
    leaves both off a cross-origin POST, and the tools' own in-process calls
    (app/mcp/client.py) carry neither.

    `Sec-Fetch-Site` is the browser's own verdict and proxies cannot confuse
    it, but it is only sent to https and localhost; on a plain-http LAN
    address `Origin` is what there is, compared with the host the browser
    dialled."""
    if method.upper() in SAFE_METHODS:
        return False
    if headers.get("authorization"):
        return False
    if not _has_session_cookie(headers.get("cookie", "")):
        return False
    site = headers.get("sec-fetch-site", "").strip().lower()
    if site:
        return site not in ("same-origin", "none")
    origin = headers.get("origin", "").strip()
    if not origin:
        return False
    return not origin_is_ours(origin, headers, peer)


class SameOriginGuard:
    """Refuses `cross_site_mutation` requests under /api before any route
    runs (403 `cross_site_request`). Not installed under Home Assistant
    ingress: there the credential is Home Assistant's, not our cookie."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("method", "GET").upper() not in SAFE_METHODS:
            path = scope.get("path", "")
            if path.startswith("/api/"):
                headers = {
                    name.decode("latin-1").lower(): value.decode("latin-1")
                    for name, value in scope.get("headers") or []
                }
                client = scope.get("client")
                peer = client[0] if client else None
                if cross_site_mutation(scope["method"], headers, peer):
                    response = JSONResponse(
                        status_code=403,
                        content={
                            "detail": {
                                "error": "cross_site_request",
                                "message": (
                                    "This request came from a page on another origin. If you opened FrameOS "
                                    "through a reverse proxy, forward the Host header or set FRAMEOS_PUBLIC_URL "
                                    "to the address you open it at."
                                ),
                            }
                        },
                    )
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)
