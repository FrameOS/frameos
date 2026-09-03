"""Home Assistant ingress: the ingress uvicorn answers to the Supervisor only.

In ``HASSIO_RUN_MODE=ingress`` the routers are mounted without any user
authentication — Home Assistant authenticates the browser and its Supervisor
proxies the request to this add-on's ingress port. That port is reachable by
every container on the ``hassio`` network, so anything that is not the
Supervisor's proxy (``172.30.32.2``, the address Home Assistant documents for
ingress traffic) is refused at the ASGI layer, for HTTP and for ``/ws`` alike.
``FRAMEOS_INGRESS_TRUSTED_PEERS`` (comma-separated) overrides the peer list
for unusual network layouts.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from app import config as app_config
from app.utils.request_ip import HASSIO_INGRESS_PROXY

log = logging.getLogger(__name__)

REJECTED_BODY = b'{"detail":"Ingress requests are accepted from the Home Assistant Supervisor only"}'


def ingress_trusted_peers() -> set[str]:
    configured = getattr(app_config.config, "FRAMEOS_INGRESS_TRUSTED_PEERS", "") or ""
    peers = {peer.strip() for peer in configured.split(",") if peer.strip()}
    return peers or {HASSIO_INGRESS_PROXY}


class IngressPeerGuard:
    """Pure ASGI middleware: 403 (HTTP) / close 1008 (WebSocket) for any
    socket peer other than the ingress proxy. Works on the raw connection
    address — uvicorn only rewrites it for loopback proxies, so a peer on
    the add-on network cannot forge it with an X-Forwarded-For header."""

    def __init__(self, app: Callable[..., Awaitable[Any]]) -> None:
        self.app = app
        self._reported: set[str] = set()

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        peer = str(client[0]) if client else ""
        if peer in ingress_trusted_peers():
            await self.app(scope, receive, send)
            return

        # One line per peer: a port scan must not flood the add-on log.
        if peer not in self._reported and len(self._reported) < 64:
            self._reported.add(peer)
            log.warning(
                "ingress request from %s rejected: not the Home Assistant Supervisor proxy (%s)",
                peer or "unknown",
                ", ".join(sorted(ingress_trusted_peers())),
            )

        if scope["type"] == "websocket":
            # Closing before accept refuses the handshake (403).
            await send({"type": "websocket.close", "code": 1008})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(REJECTED_BODY)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": REJECTED_BODY})
