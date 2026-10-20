"""The relay in front of the provider hub: transparent, both ways.

A small stand-in for the hub (the real one is the sidecar's, with its own
integration suite) answers the upgrade the way the hub does — a plain HTTP
refusal for a bad token — then plays a session. What the device must see is
the hub's answer, unchanged: the status of a refusal (a 401 counts toward
demotion, a 429 must not), the messages, and the close codes.
"""
from __future__ import annotations

import asyncio
import json
import threading
from http import HTTPStatus
from typing import Generator

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

from app import fastapi as fastapi_module
from app.config import config
from app.fastapi import app


class FakeHub:
    """Refuses a bad token with the hub's 401 body; then challenges, echoes,
    and closes with whatever code the device asks for."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.port = 0
        self.seen_headers: list[dict[str, str]] = []
        self._ready = threading.Event()
        self._stop: asyncio.Future | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._serve())

    async def _serve(self) -> None:
        def process_request(connection, request):
            self.seen_headers.append(dict(request.headers.raw_items()))
            authorization = request.headers.get("Authorization", "")
            if authorization == "Bearer limited":
                return Response(429, "Too Many Requests", Headers([("Content-Type", "application/json")]), b'{"error":"rate_limited"}')
            if authorization != "Bearer good":
                return Response(401, "Unauthorized", Headers([("Content-Type", "application/json")]), b'{"error":"invalid_link_token"}')
            return None

        async def handler(socket):
            await socket.send(json.dumps({"type": "challenge", "nonce": "AAAA"}))
            async for raw in socket:
                message = json.loads(raw)
                if message.get("type") == "close_me":
                    await socket.close(code=int(message["code"]), reason="as asked")
                    return
                await socket.send(json.dumps({"echo": message}))

        async with serve(handler, "127.0.0.1", 0, process_request=process_request) as server:
            self.port = server.sockets[0].getsockname()[1]
            self._stop = self.loop.create_future()
            self._ready.set()
            await self._stop

    def start(self) -> "FakeHub":
        self.thread.start()
        self._ready.wait(5)
        return self

    def stop(self) -> None:
        if self._stop is not None:
            self.loop.call_soon_threadsafe(self._stop.set_result, None)
        self.thread.join(5)


@pytest.fixture
def hub(monkeypatch) -> Generator[FakeHub, None, None]:
    fake = FakeHub().start()
    monkeypatch.setattr(config, "FRAMEOS_PROVIDER_HUB_URL", f"ws://127.0.0.1:{fake.port}")
    yield fake
    fake.stop()


@pytest.fixture
def client(monkeypatch) -> Generator[TestClient, None, None]:
    async def no_redis_listener():
        pass

    monkeypatch.setattr(fastapi_module, "redis_listener", no_redis_listener)
    with TestClient(app) as test_client:
        yield test_client


def receive(ws, seconds: float = 5.0) -> dict:
    async def _receive():
        with anyio.fail_after(seconds):
            return await ws._send_rx.receive()

    message = ws.portal.call(_receive)
    ws._raise_on_close(message)
    return json.loads(message["text"])


def test_the_hubs_refusal_reaches_the_device_unchanged(hub, client):
    with pytest.raises(WebSocketDenialResponse) as denied:
        with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer bad"}):
            pass
    assert denied.value.status_code == HTTPStatus.UNAUTHORIZED
    assert denied.value.json() == {"error": "invalid_link_token"}
    # A rate limit is not an authentication failure; it must not become one.
    with pytest.raises(WebSocketDenialResponse) as limited:
        with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer limited"}):
            pass
    assert limited.value.status_code == HTTPStatus.TOO_MANY_REQUESTS


def test_a_session_relays_both_ways_with_the_devices_token(hub, client):
    with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer good"}) as session:
        assert receive(session) == {"type": "challenge", "nonce": "AAAA"}
        session.send_json({"type": "hello", "frameos_version": "2026.10.18"})
        assert receive(session) == {"echo": {"type": "hello", "frameos_version": "2026.10.18"}}
    headers = {key.lower(): value for key, value in hub.seen_headers[-1].items()}
    assert headers["authorization"] == "Bearer good"
    assert "x-forwarded-for" in headers


def test_the_hubs_close_code_reaches_the_device(hub, client):
    with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer good"}) as session:
        receive(session)
        session.send_json({"type": "close_me", "code": 4401})
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(session)
        assert closed.value.code == 4401


def test_a_hub_that_is_down_is_a_503_not_a_401(client, monkeypatch):
    monkeypatch.setattr(config, "FRAMEOS_PROVIDER_HUB_URL", "ws://127.0.0.1:1")
    with pytest.raises(WebSocketDenialResponse) as denied:
        with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer good"}):
            pass
    assert denied.value.status_code == HTTPStatus.SERVICE_UNAVAILABLE
