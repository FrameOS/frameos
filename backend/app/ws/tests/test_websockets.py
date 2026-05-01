from typing import Generator

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import fastapi as fastapi_module
from app.fastapi import app
from app.database import SessionLocal
from app.models.user import User
from app.redis import get_redis


class DummyRedis:
    async def close(self, *args, **kwargs):
        pass

    async def set(self, *args, **kwargs):
        pass

    async def expire(self, *args, **kwargs):
        pass

    async def publish(self, *args, **kwargs):
        pass

    async def rpush(self, *args, **kwargs):
        pass

    async def get(self, *args, **kwargs):
        return None

    async def incr(self, *args, **kwargs):
        pass

    async def delete(self, *args, **kwargs):
        pass


def create_user(email: str = "test@example.com", password: str = "testpassword") -> None:
    db = SessionLocal()
    user = User(email=email)
    user.set_password(password)
    db.add(user)
    db.commit()
    db.close()


@pytest.fixture
def client(monkeypatch) -> Generator[TestClient, None, None]:
    async def fake_redis_listener():
        pass

    monkeypatch.setattr(fastapi_module, "redis_listener", fake_redis_listener)

    async def get_redis_override():
        yield DummyRedis()

    app.dependency_overrides[get_redis] = get_redis_override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_ws_missing_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Missing token"


def test_ws_invalid_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws?token=bad"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Invalid token"


def test_ws_valid_token_echo(client: TestClient) -> None:
    create_user()
    login_resp = client.post("/api/login", data={"username": "test@example.com", "password": "testpassword"})
    token = login_resp.json()["access_token"]
    with client.websocket_connect(f"/ws?token={token}") as ws:
        ws.send_text("ping")
        data = ws.receive_json()
    assert data == {"event": "pong", "payload": "ping"}


def test_ws_session_cookie_echo(client: TestClient) -> None:
    create_user(email="cookie@example.com", password="testpassword")
    login_resp = client.post("/api/login", data={"username": "cookie@example.com", "password": "testpassword"})
    assert login_resp.status_code == 200

    with client.websocket_connect("/ws") as ws:
        ws.send_text("ping")
        data = ws.receive_json()
    assert data == {"event": "pong", "payload": "ping"}


def test_terminal_ws_session_cookie_frame_not_found(client: TestClient) -> None:
    create_user(email="cookie-terminal@example.com", password="testpassword")
    login_resp = client.post(
        "/api/login",
        data={"username": "cookie-terminal@example.com", "password": "testpassword"},
    )
    assert login_resp.status_code == 200

    with client.websocket_connect("/ws/terminal/999") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "Frame not found"

def test_terminal_ws_missing_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/terminal/1"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Missing token"


def test_terminal_ws_invalid_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/terminal/1?token=bad"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Invalid token"


def test_terminal_ws_frame_not_found(client: TestClient) -> None:
    create_user()
    login_resp = client.post("/api/login", data={"username": "test@example.com", "password": "testpassword"})
    token = login_resp.json()["access_token"]
    with client.websocket_connect(f"/ws/terminal/999?token={token}") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "Frame not found"


def test_agent_ws_requires_hello(client: TestClient) -> None:
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"action": "nohello"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "expected hello"


def test_agent_ws_unknown_frame(client: TestClient) -> None:
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"action": "hello", "serverApiKey": "missing"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "unknown frame"


@pytest.mark.asyncio
async def test_broadcast_removes_failed_connection_without_deadlock() -> None:
    import asyncio

    from app.websockets import ConnectionManager

    class BrokenWebSocket:
        client = "broken"

        async def send_text(self, message: str) -> None:
            raise RuntimeError("closed")

    manager = ConnectionManager()
    broken = BrokenWebSocket()
    manager.active_connections.append(broken)  # type: ignore[arg-type]

    await asyncio.wait_for(manager.broadcast("message"), timeout=1)

    assert manager.active_connections == []


@pytest.mark.asyncio
async def test_agent_helper_closes_owned_redis(monkeypatch) -> None:
    from app.ws import agent_ws

    class FakeRedis:
        pass

    fake_redis = FakeRedis()
    closed = []

    monkeypatch.setattr(agent_ws, "create_redis_connection", lambda: fake_redis)

    async def fake_close_redis_connection(redis):
        closed.append(redis)

    async def fake_send_cmd(*args, **kwargs):
        raise RuntimeError("command failed")

    monkeypatch.setattr(agent_ws, "close_redis_connection", fake_close_redis_connection)
    monkeypatch.setattr(agent_ws, "send_cmd", fake_send_cmd)

    with pytest.raises(RuntimeError, match="command failed"):
        await agent_ws.file_md5_on_frame(1, "/srv/assets/test.png")

    assert closed == [fake_redis]


@pytest.mark.asyncio
async def test_agent_command_slot_times_out_when_frame_busy() -> None:
    from app.ws.agent_bridge import frame_command_slot

    async with frame_command_slot(987654, queue_timeout=None):
        with pytest.raises(TimeoutError, match="agent command queue busy"):
            async with frame_command_slot(987654, queue_timeout=0.01):
                pass
