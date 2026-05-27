import json
from types import SimpleNamespace

import pytest

from app.utils import remote_exec


class FakeAgentCommandRedis:
    def __init__(self) -> None:
        self.pushed: list[tuple[str, bytes]] = []
        self.deleted: list[str] = []
        self._responses = ["stream", "resp"]

    async def rpush(self, key: str, value: bytes) -> None:
        self.pushed.append((key, value))

    async def blpop(self, keys, timeout=None):
        response = self._responses.pop(0)
        if response == "stream":
            return keys[0].encode(), json.dumps({"stream": "stdout", "data": "raspios"}).encode()
        if response == "resp":
            return keys[1].encode(), json.dumps({"ok": True, "result": {"exit": 0}}).encode()
        return None

    async def lrange(self, key: str, start: int, end: int):
        return []

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


@pytest.mark.asyncio
async def test_agent_run_command_preserves_output_without_requesting_log(monkeypatch):
    redis = FakeAgentCommandRedis()
    frame = SimpleNamespace(id=123)
    logged: list[str] = []

    async def fake_log(_db, _redis, _frame_id, _type, line, timestamp=None):
        logged.append(line)

    monkeypatch.setattr(remote_exec, "log", fake_log)

    status, stdout, stderr = await remote_exec._run_command_agent(
        None,
        redis,
        frame,
        "cat /etc/os-release",
        timeout=30,
        log_output=False,
        log_command=False,
    )

    assert status == 0
    assert stdout == "raspios"
    assert stderr == ""
    assert logged == []
    key, raw_job = redis.pushed[0]
    assert key == "agent:cmd:123"
    assert json.loads(raw_job)["log"] is False
