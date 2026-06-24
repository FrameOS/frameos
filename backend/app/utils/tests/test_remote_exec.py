import asyncio
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
    assert key == "remote:cmd:123"
    assert json.loads(raw_job)["log"] is False


class FakeSSH:
    def __init__(self) -> None:
        self.aborted = False

    def abort(self) -> None:
        self.aborted = True


def _patch_scp_env(monkeypatch, scp_impl, logged):
    connections: list[FakeSSH] = []

    async def fake_use_agent(_frame, _redis, _transport):
        return False

    async def fake_get_ssh_connection(_db, _redis, _frame):
        ssh = FakeSSH()
        connections.append(ssh)
        return ssh

    async def fake_remove_ssh_connection(_db, _redis, _ssh, _frame):
        pass

    async def fake_log(_db, _redis, _frame_id, log_type, line, timestamp=None):
        logged.append((log_type, line))

    monkeypatch.setattr(remote_exec, "_use_agent", fake_use_agent)
    monkeypatch.setattr(remote_exec, "get_ssh_connection", fake_get_ssh_connection)
    monkeypatch.setattr(remote_exec, "remove_ssh_connection", fake_remove_ssh_connection)
    monkeypatch.setattr(remote_exec, "log", fake_log)
    monkeypatch.setattr(remote_exec.asyncssh, "scp", scp_impl)
    # Keep stall detection fast: the watchdog polls every second, so a hanging
    # transfer is declared stalled on its first check.
    monkeypatch.setattr(remote_exec, "SCP_STALL_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(remote_exec, "SCP_MAX_ATTEMPTS", 2)
    return connections


@pytest.mark.asyncio
async def test_upload_file_scp_success(monkeypatch):
    logged: list[tuple[str, str]] = []
    calls: list[str] = []

    async def fake_scp(_src, dst, recurse=False, progress_handler=None):
        calls.append(dst[1])
        if progress_handler:
            progress_handler(None, None, 4, 4)

    connections = _patch_scp_env(monkeypatch, fake_scp, logged)
    frame = SimpleNamespace(id=1, agent={})

    await remote_exec.upload_file(None, None, frame, "/tmp/target", b"data")

    assert len(calls) == 1
    assert not connections[0].aborted
    assert any("scp →" in line for _t, line in logged)


@pytest.mark.asyncio
async def test_upload_file_scp_retries_after_stall(monkeypatch):
    logged: list[tuple[str, str]] = []
    calls: list[int] = []

    async def fake_scp(_src, _dst, recurse=False, progress_handler=None):
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(3600)  # stalled transfer: no progress, never returns

    connections = _patch_scp_env(monkeypatch, fake_scp, logged)
    frame = SimpleNamespace(id=1, agent={})

    await remote_exec.upload_file(None, None, frame, "/tmp/target", b"data")

    assert len(calls) == 2
    assert connections[0].aborted
    assert not connections[1].aborted
    assert any("stalled" in line for _t, line in logged)
    assert any("attempt 2/2" in line for _t, line in logged)


@pytest.mark.asyncio
async def test_upload_file_scp_fails_after_max_attempts(monkeypatch):
    logged: list[tuple[str, str]] = []

    async def fake_scp(_src, _dst, recurse=False, progress_handler=None):
        await asyncio.sleep(3600)

    connections = _patch_scp_env(monkeypatch, fake_scp, logged)
    frame = SimpleNamespace(id=1, agent={})

    with pytest.raises(RuntimeError, match="failed after 2 attempts"):
        await remote_exec.upload_file(None, None, frame, "/tmp/target", b"data")

    assert len(connections) == 2
    assert all(ssh.aborted for ssh in connections)
