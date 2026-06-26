import json
import asyncio
from types import SimpleNamespace
from typing import Generator

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import fastapi as fastapi_module
from app.fastapi import app
from app.database import SessionLocal
from app.codegen.drivers_nim import frame_compilation_mode
from app.models import new_frame
from app.models.frame import Frame
from app.models.user import User
from app.redis import get_redis
from app.tenancy import ensure_default_project_for_user
from app.tasks.buildroot_image import (
    BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
    SUPPORTED_BUILDROOT_PLATFORM,
    buildroot_sd_image_config_fingerprint,
)
from app.ws.remote_ws import hmac_sha256


class DummyRedis:
    async def blpop(self, *args, **kwargs):
        await asyncio.sleep(3600)

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

    async def scan_iter(self, *args, **kwargs):
        if False:
            yield None


def create_user(email: str = "test@example.com", password: str = "testpassword") -> int:
    db = SessionLocal()
    user = User(email=email)
    user.set_password(password)
    db.add(user)
    db.commit()
    db.refresh(user)
    project = ensure_default_project_for_user(db, user)
    project_id = project.id
    db.close()
    return project_id


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
    project_id = create_user(email="cookie-terminal@example.com", password="testpassword")
    login_resp = client.post(
        "/api/login",
        data={"username": "cookie-terminal@example.com", "password": "testpassword"},
    )
    assert login_resp.status_code == 200

    with client.websocket_connect(f"/ws/projects/{project_id}/terminal/999") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "Frame not found"

def test_terminal_ws_missing_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/projects/1/terminal/1"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Missing token"


def test_terminal_ws_invalid_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/projects/1/terminal/1?token=bad"):
            pass
    assert exc.value.code == 1008
    assert exc.value.reason == "Invalid token"


def test_terminal_ws_frame_not_found(client: TestClient) -> None:
    project_id = create_user()
    login_resp = client.post("/api/login", data={"username": "test@example.com", "password": "testpassword"})
    token = login_resp.json()["access_token"]
    with client.websocket_connect(f"/ws/projects/{project_id}/terminal/999?token={token}") as ws:
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "Frame not found"


def test_remote_ws_requires_hello(client: TestClient) -> None:
    with client.websocket_connect("/ws/remote") as ws:
        ws.send_json({"action": "nohello"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "expected hello"


def test_legacy_agent_ws_route_is_still_accepted(client: TestClient) -> None:
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"action": "nohello"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "expected hello"


def test_remote_ws_unknown_frame(client: TestClient) -> None:
    with client.websocket_connect("/ws/remote") as ws:
        ws.send_json({"action": "hello", "serverApiKey": "missing"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 1008
    assert exc.value.reason == "unknown frame"


def test_remote_ws_stores_reported_version_and_clears_missing_version(client: TestClient) -> None:
    db = SessionLocal()
    try:
        frame = asyncio.run(new_frame(db, DummyRedis(), "RemoteVersionFrame", "frame-remote.local", "localhost"))
        secret = "agent-secret"
        frame.agent = {
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": secret,
            "agentVersion": "2026.1.1",
            "remoteCapabilities": {"fileWriteStream": False},
        }
        db.add(frame)
        db.commit()
        db.refresh(frame)
        frame_id = frame.id
        server_api_key = frame.server_api_key
    finally:
        db.close()

    with client.websocket_connect("/ws/remote") as ws:
        ws.send_json({
            "action": "hello",
            "serverApiKey": server_api_key,
            "remoteVersion": "2026.6.11+abc",
            "remoteCapabilities": {"fileWriteStream": True, "ignored": "not-bool"},
        })
        challenge = ws.receive_json()
        ws.send_json({
            "action": "handshake",
            "mac": hmac_sha256(secret, f"{server_api_key}{challenge['c']}"),
        })
        assert ws.receive_json() == {"action": "handshake/ok"}

    db = SessionLocal()
    try:
        updated = db.get(Frame, frame_id)
        assert updated is not None
        assert updated.agent["agentVersion"] == "2026.6.11+abc"
        assert updated.agent["remoteCapabilities"] == {"fileWriteStream": True}
    finally:
        db.close()

    with client.websocket_connect("/ws/remote") as ws:
        ws.send_json({"action": "hello", "serverApiKey": server_api_key})
        challenge = ws.receive_json()
        ws.send_json({
            "action": "handshake",
            "mac": hmac_sha256(secret, f"{server_api_key}{challenge['c']}"),
        })
        assert ws.receive_json() == {"action": "handshake/ok"}

    db = SessionLocal()
    try:
        updated = db.get(Frame, frame_id)
        assert updated is not None
        assert "agentVersion" not in updated.agent
        assert "remoteCapabilities" not in updated.agent
    finally:
        db.close()


def test_remote_ws_marks_matching_buildroot_sd_image_deployed_on_first_boot(client: TestClient) -> None:
    db = SessionLocal()
    try:
        frame = asyncio.run(new_frame(db, DummyRedis(), "BuildrootFrame", "frame53.local", "localhost"))
        secret = "agent-secret"
        frame.mode = "buildroot"
        frame.status = "uninitialized"
        frame.agent = {
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": secret,
        }
        frame.buildroot = {
            "platform": SUPPORTED_BUILDROOT_PLATFORM,
            "sdImage": {
                "status": "ready",
                "platform": SUPPORTED_BUILDROOT_PLATFORM,
                "frameosVersion": "2026.6.2",
                "customizationVersion": BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
                "compilationMode": frame_compilation_mode(frame),
            },
        }
        db.add(frame)
        db.commit()
        db.refresh(frame)
        sd_image = dict(frame.buildroot["sdImage"])
        sd_image["configFingerprint"] = buildroot_sd_image_config_fingerprint(frame)
        frame.buildroot = {**frame.buildroot, "sdImage": sd_image}
        frame.width = 200
        frame.height = 300
        db.add(frame)
        db.commit()
        frame_id = frame.id
        server_api_key = frame.server_api_key
    finally:
        db.close()

    with client.websocket_connect("/ws/remote") as ws:
        ws.send_json({"action": "hello", "serverApiKey": server_api_key})
        challenge = ws.receive_json()
        ws.send_json({
            "action": "handshake",
            "mac": hmac_sha256(secret, f"{server_api_key}{challenge['c']}"),
        })
        assert ws.receive_json() == {"action": "handshake/ok"}

    db = SessionLocal()
    try:
        updated = db.get(Frame, frame_id)
        assert updated is not None
        assert updated.last_successful_deploy_at is not None
        assert updated.last_successful_deploy["id"] == frame_id
        assert updated.last_successful_deploy["frameos_version"] == "2026.6.2"
        assert updated.last_successful_deploy["frameos_commands"] == ["start", "check", "setup", "help"]
        assert updated.last_successful_deploy["width"] == 200
        assert updated.last_successful_deploy["height"] == 300
        assert updated.status == "starting"
    finally:
        db.close()


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
async def test_broadcast_sends_to_slow_connections_concurrently(monkeypatch) -> None:
    from app import websockets
    from app.websockets import ConnectionManager

    monkeypatch.setattr(websockets, "WEBSOCKET_BROADCAST_TIMEOUT", 0.2)
    started = 0
    all_started = asyncio.Event()

    class SlowWebSocket:
        def __init__(self, client: str):
            self.client = client

        async def send_text(self, message: str) -> None:
            nonlocal started
            started += 1
            if started == 2:
                all_started.set()
            await asyncio.sleep(3600)

    manager = ConnectionManager()
    manager.active_connections.extend([SlowWebSocket("slow-1"), SlowWebSocket("slow-2")])  # type: ignore[list-item]

    task = asyncio.create_task(manager.broadcast("message"))
    await asyncio.wait_for(all_started.wait(), timeout=0.1)
    await task

    assert manager.active_connections == []


@pytest.mark.asyncio
async def test_broadcast_filters_project_scoped_events_by_connection_projects() -> None:
    from app.websockets import ConnectionManager

    class FakeWebSocket:
        def __init__(self, client: str):
            self.client = client
            self.sent: list[str] = []

        async def send_text(self, message: str) -> None:
            self.sent.append(message)

    project_one = FakeWebSocket("project-1")
    project_two = FakeWebSocket("project-2")
    full_access = FakeWebSocket("full-access")
    manager = ConnectionManager()
    manager.active_connections.extend([project_one, project_two, full_access])  # type: ignore[list-item]
    manager.connection_project_ids[project_one] = {1}  # type: ignore[index]
    manager.connection_project_ids[project_two] = {2}  # type: ignore[index]
    manager.connection_project_ids[full_access] = None  # type: ignore[index]

    message = json.dumps({"event": "update_frame", "data": {"id": 5, "project_id": 1}})
    await manager.broadcast(message)

    assert project_one.sent == [message]
    assert project_two.sent == []
    assert full_access.sent == [message]


@pytest.mark.asyncio
async def test_broadcast_does_not_send_unscoped_project_events_to_scoped_connections() -> None:
    from app.websockets import ConnectionManager

    class FakeWebSocket:
        def __init__(self, client: str):
            self.client = client
            self.sent: list[str] = []

        async def send_text(self, message: str) -> None:
            self.sent.append(message)

    scoped = FakeWebSocket("scoped")
    full_access = FakeWebSocket("full-access")
    manager = ConnectionManager()
    manager.active_connections.extend([scoped, full_access])  # type: ignore[list-item]
    manager.connection_project_ids[scoped] = {1}  # type: ignore[index]
    manager.connection_project_ids[full_access] = None  # type: ignore[index]

    message = json.dumps({"event": "update_frame", "data": {"id": 5}})
    await manager.broadcast(message)

    assert scoped.sent == []
    assert full_access.sent == [message]


@pytest.mark.asyncio
async def test_remote_helper_closes_owned_redis(monkeypatch) -> None:
    from app.ws import remote_ws

    class FakeRedis:
        pass

    fake_redis = FakeRedis()
    closed = []

    monkeypatch.setattr(remote_ws, "create_redis_connection", lambda: fake_redis)

    async def fake_close_redis_connection(redis):
        closed.append(redis)

    async def fake_send_cmd(*args, **kwargs):
        raise RuntimeError("command failed")

    monkeypatch.setattr(remote_ws, "close_redis_connection", fake_close_redis_connection)
    monkeypatch.setattr(remote_ws, "send_cmd", fake_send_cmd)

    with pytest.raises(RuntimeError, match="command failed"):
        await remote_ws.file_md5_on_frame(1, "/srv/assets/test.png")

    assert closed == [fake_redis]


@pytest.mark.asyncio
async def test_remote_command_slot_times_out_when_frame_busy() -> None:
    from app.ws.remote_bridge import frame_command_slot

    async with frame_command_slot(987654, queue_timeout=None):
        with pytest.raises(TimeoutError, match="remote command queue busy"):
            async with frame_command_slot(987654, queue_timeout=0.01):
                pass


@pytest.mark.asyncio
async def test_pump_commands_fails_pending_command_when_websocket_send_drops() -> None:
    from app.ws.remote_bridge import RESP_KEY
    from app.ws.remote_ws import REMOTE_DISCONNECTED_ERROR, pump_commands

    class FakeRedis:
        def __init__(self) -> None:
            self.pushed: list[tuple[str, bytes]] = []
            self.expired: list[tuple[str, int]] = []

        async def blpop(self, key: str, timeout=0):
            job = {
                "id": "cmd-1",
                "frame_id": 42,
                "payload": {"type": "cmd", "name": "shell", "args": {"cmd": "sync"}},
                "timeout": 30,
            }
            return key.encode(), json.dumps(job).encode()

        async def rpush(self, key: str, value: bytes) -> None:
            self.pushed.append((key, value))

        async def expire(self, key: str, seconds: int) -> None:
            self.expired.append((key, seconds))

    class DroppingWebSocket:
        def __init__(self) -> None:
            self.scope: dict[str, object] = {}

        async def send_json(self, _payload) -> None:
            raise RuntimeError("socket closed")

        async def send_bytes(self, _payload) -> None:
            raise AssertionError("no blob should be sent")

    redis = FakeRedis()
    ws = DroppingWebSocket()

    await pump_commands(ws, 42, "server-key", "shared-secret", redis)  # type: ignore[arg-type]

    assert ws.scope["cmd_buffers"] == {}
    assert redis.expired == [(RESP_KEY.format(id="cmd-1"), 60)]
    assert len(redis.pushed) == 1
    key, raw = redis.pushed[0]
    assert key == RESP_KEY.format(id="cmd-1")
    reply = json.loads(raw)
    assert reply == {
        "ok": False,
        "error": REMOTE_DISCONNECTED_ERROR,
        "result": {"error": REMOTE_DISCONNECTED_ERROR},
    }


@pytest.mark.asyncio
async def test_remote_stream_chunk_can_skip_frame_logs(monkeypatch) -> None:
    from app.ws import remote_ws

    class FakeRedis:
        def __init__(self) -> None:
            self.pushed: list[tuple[str, bytes]] = []
            self.expired: list[tuple[str, int]] = []

        async def rpush(self, key: str, value: bytes) -> None:
            self.pushed.append((key, value))

        async def expire(self, key: str, seconds: int) -> None:
            self.expired.append((key, seconds))

    logged: list[tuple[int, str, str]] = []

    async def fake_write_log(_redis, frame_id: int, type: str, line: str, ip: str | None = None):
        logged.append((frame_id, type, line))

    monkeypatch.setattr(remote_ws, "write_log", fake_write_log)

    redis = FakeRedis()
    frame = SimpleNamespace(id=77)
    ws = SimpleNamespace(scope={"cmd_log_output": {"quiet-cmd": False}})

    await remote_ws.handle_remote_stream_chunk(
        ws,
        redis,
        frame,
        {"id": "quiet-cmd", "type": "cmd/stream", "stream": "stdout", "data": "raspios\nbookworm"},
        client_ip="127.0.0.1",
    )

    assert logged == []
    assert [json.loads(raw) for _key, raw in redis.pushed] == [
        {"stream": "stdout", "data": "raspios"},
        {"stream": "stdout", "data": "bookworm"},
    ]
    assert redis.expired == [("remote:cmd:stream:quiet-cmd", 300)]


@pytest.mark.asyncio
async def test_remote_stream_chunk_logs_by_default(monkeypatch) -> None:
    from app.ws import remote_ws

    class FakeRedis:
        async def rpush(self, _key: str, _value: bytes) -> None:
            pass

        async def expire(self, _key: str, _seconds: int) -> None:
            pass

    logged: list[tuple[int, str, str]] = []

    async def fake_write_log(_redis, frame_id: int, type: str, line: str, ip: str | None = None):
        logged.append((frame_id, type, line))

    monkeypatch.setattr(remote_ws, "write_log", fake_write_log)

    frame = SimpleNamespace(id=88)
    ws = SimpleNamespace(scope={})

    await remote_ws.handle_remote_stream_chunk(
        ws,
        FakeRedis(),
        frame,
        {"id": "normal-cmd", "type": "cmd/stream", "stream": "stdout", "data": "visible"},
        client_ip=None,
    )

    assert logged == [(88, "stdout", "visible")]
