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