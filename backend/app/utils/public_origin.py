"""The origin a client outside this process should dial, for URLs the UI
shows people (the MCP endpoint on the settings page) and links in MCP tool
output."""
from __future__ import annotations

from urllib.parse import urlparse

from fastapi import Request

from app import config as app_config
from app.utils.request_ip import peer_is_trusted_proxy


def public_origin(request: Request) -> str:
    """`FRAMEOS_PUBLIC_URL` when configured; otherwise the host the browser
    dialled (`X-Forwarded-Host` from a trusted proxy, else `Host`) with the
    scheme the proxy reports."""
    configured = (app_config.config.FRAMEOS_PUBLIC_URL or "").strip()
    if configured:
        parsed = urlparse(configured)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    host = request.headers.get("host", "")
    peer = request.client.host if request.client else None
    if peer_is_trusted_proxy(peer):
        forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
        if forwarded_host:
            host = forwarded_host
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    scheme = "https" if request.url.scheme == "https" or forwarded_proto == "https" else "http"
    return f"{scheme}://{host}"


def mcp_url(request: Request) -> str:
    return f"{public_origin(request)}{app_config.config.ingress_path or ''}/api/mcp"
