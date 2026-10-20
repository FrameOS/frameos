"""`/api/frames/ws` on the backend's own port, relayed to the provider hub.

A frame enrolled with a backend claim code dials `{backend}/api/frames/ws`
(the Linux runtime always dials `provider_url + ws_path`; docs/cloud-frames.md),
and the socket's other end is FrameOS Cloud's frame hub in the provider
sidecar (cloud/apps/backend-provider) on 127.0.0.1. The Home Assistant add-on
exposes one port, so the backend relays the upgrade rather than publishing
the hub's.

The relay is transparent on purpose — every rule is the hub's:
- the upgrade: the device's `Authorization` goes through as is, and the
  hub's own HTTP refusal comes back with its status and body (a 401 counts
  toward the device's demotion, a 429 or 503 does not, so it must not turn
  into anything else);
- text frames both ways, unchanged;
- close codes both ways (4401 / 4408 / 4409 / 4410 mean something to the
  device; 1006 is what a vanished peer looks like).
The device's address rides `X-Forwarded-For`, which the hub's per-address
rate limit reads (RATE_LIMIT_TRUSTED_PROXY_COUNT=1 in the sidecar).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket
from fastapi.responses import Response
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from app.config import config
from app.utils.request_ip import client_ip_for_request

logger = logging.getLogger(__name__)
router = APIRouter()

DEVICE_PATH = "/api/frames/ws"
# The hub's maxPayloadBytes, with room for the frame header.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024 + 1024
OPEN_TIMEOUT_SECONDS = 10.0


def _hub_url() -> str:
    return config.FRAMEOS_PROVIDER_HUB_URL.rstrip("/") + DEVICE_PATH


@router.websocket(DEVICE_PATH)
async def relay_provider_frame_socket(ws: WebSocket):
    headers = {"X-Forwarded-For": client_ip_for_request(ws) or ""}
    authorization = ws.headers.get("authorization")
    if authorization:
        headers["Authorization"] = authorization
    try:
        upstream = await connect(
            _hub_url(),
            additional_headers=headers,
            max_size=MAX_MESSAGE_BYTES,
            open_timeout=OPEN_TIMEOUT_SECONDS,
            # The hub pings; the client library answers. uvicorn pings the
            # device on this side, so a dead peer on either side closes both.
            ping_interval=None,
            compression=None,
        )
    except InvalidStatus as exc:
        response = exc.response
        await ws.send_denial_response(
            Response(
                content=bytes(response.body or b""),
                status_code=response.status_code,
                media_type=response.headers.get("Content-Type") or "application/json",
            )
        )
        return
    except (OSError, asyncio.TimeoutError) as exc:
        logger.warning("provider relay: the hub is not reachable at %s: %s", _hub_url(), exc)
        await ws.send_denial_response(
            Response(content=b'{"error":"provider_unavailable"}', status_code=503, media_type="application/json")
        )
        return

    await ws.accept()

    async def device_to_hub() -> tuple[int, str]:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                return int(message.get("code") or 1000), str(message.get("reason") or "")
            text = message.get("text")
            if text is not None:
                await upstream.send(text)
            elif message.get("bytes") is not None:
                await upstream.send(message["bytes"])

    async def hub_to_device() -> tuple[int, str]:
        try:
            async for data in upstream:
                if isinstance(data, str):
                    await ws.send_text(data)
                else:
                    await ws.send_bytes(data)
        except ConnectionClosed:
            pass
        received = upstream.close_code
        return (received if received is not None else 1006), upstream.close_reason or ""

    to_hub = asyncio.create_task(device_to_hub())
    to_device = asyncio.create_task(hub_to_device())
    try:
        done, pending = await asyncio.wait({to_hub, to_device}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        finished = done.pop()
        try:
            code, reason = finished.result()
        except (WebSocketDisconnect, ConnectionClosed, RuntimeError):
            code, reason = 1006, ""
        if finished is to_device:
            # The hub closed: tell the device with the hub's own code. 1006
            # (no close frame) cannot be sent; the device sees a plain close.
            with contextlib.suppress(Exception):
                await ws.close(code=code if code not in (1005, 1006) else 1011, reason=reason)
        else:
            with contextlib.suppress(Exception):
                await upstream.close(code=code if code not in (1005, 1006) else 1000, reason=reason)
    finally:
        with contextlib.suppress(Exception):
            await upstream.close()
