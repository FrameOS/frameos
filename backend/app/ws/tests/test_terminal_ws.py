import json
from types import SimpleNamespace

import pytest

from app.ws import terminal_ws


class FakeTerminalWebSocket:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, message: str) -> None:
        self.sent.append(message)


class FakeRemoteRedis:
    def __init__(self):
        self.pushed: list[tuple[str, bytes]] = []
        self.deleted: list[str] = []
        self._responses = ["stream", "resp"]

    async def rpush(self, key: str, value: bytes) -> None:
        self.pushed.append((key, value))

    async def blpop(self, keys, timeout=None):
        response = self._responses.pop(0)
        if response == "stream":
            return keys[0], json.dumps({"stream": "stdout", "data": "hello"}).encode()
        if response == "resp":
            return keys[1], json.dumps({"ok": False, "result": {"exit": 2}}).encode()
        return None

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


@pytest.mark.asyncio
async def test_should_use_remote_terminal_requires_enabled_commands_and_connection(monkeypatch):
    async def fake_connection_count(redis, frame_id):
        return 1

    monkeypatch.setattr(terminal_ws, "number_of_connections_for_frame", fake_connection_count)

    frame = SimpleNamespace(
        id=123,
        agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
    )
    assert await terminal_ws._should_use_remote_terminal(object(), frame)

    frame.agent["deployWithAgent"] = False
    assert not await terminal_ws._should_use_remote_terminal(object(), frame)

    frame.agent["deployWithAgent"] = True
    frame.agent["agentRunCommands"] = False
    assert not await terminal_ws._should_use_remote_terminal(object(), frame)


@pytest.mark.asyncio
async def test_run_remote_terminal_command_streams_output_and_exit_status():
    redis = FakeRemoteRedis()
    websocket = FakeTerminalWebSocket()
    frame = SimpleNamespace(id=987654321)

    await terminal_ws._run_remote_terminal_command(websocket, redis, frame, "echo hello")

    assert len(redis.pushed) == 1
    key, raw_job = redis.pushed[0]
    assert key == "remote:cmd:987654321"

    job = json.loads(raw_job)
    assert job["frame_id"] == frame.id
    assert job["payload"] == {"type": "cmd", "name": "shell", "args": {"cmd": "echo hello"}}
    assert job["log"] is False

    assert websocket.sent == [
        "$ echo hello\n",
        "hello\n",
        "*** command exited with status 2 ***\n",
    ]
    assert redis.deleted == [f"remote:cmd:stream:{job['id']}"]


@pytest.mark.asyncio
async def test_send_remote_stream_chunk_preserves_raw_terminal_data():
    websocket = FakeTerminalWebSocket()

    await terminal_ws._send_remote_stream_chunk(websocket, {"data": "pi@frame:/srv$ ", "raw": True})
    await terminal_ws._send_remote_stream_chunk(websocket, {"data": "hello", "raw": False})

    assert websocket.sent == ["pi@frame:/srv$ ", "hello\n"]


@pytest.mark.asyncio
async def test_queue_remote_terminal_command_uses_terminal_payload():
    redis = FakeRemoteRedis()
    frame = SimpleNamespace(id=42)

    await terminal_ws._queue_remote_terminal_command(
        redis,
        frame,
        "terminal-id",
        "terminal_input",
        {"terminal_id": "session-id", "data": "cd /srv\n"},
        timeout=30,
    )

    assert len(redis.pushed) == 1
    key, raw_job = redis.pushed[0]
    assert key == "remote:cmd:42"
    assert json.loads(raw_job) == {
        "id": "terminal-id",
        "frame_id": 42,
        "payload": {
            "type": "cmd",
            "name": "terminal_input",
            "args": {"terminal_id": "session-id", "data": "cd /srv\n"},
        },
        "log": False,
        "timeout": 30,
    }
