import asyncio
import json
from types import SimpleNamespace

import pytest

from app.utils import remote_exec


class FakeRemoteCommandRedis:
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
async def test_remote_run_command_preserves_output_without_requesting_log(monkeypatch):
    redis = FakeRemoteCommandRedis()
    frame = SimpleNamespace(id=123)
    logged: list[str] = []

    async def fake_log(_db, _redis, _frame_id, _type, line, timestamp=None):
        logged.append(line)

    monkeypatch.setattr(remote_exec, "log", fake_log)

    status, stdout, stderr = await remote_exec._run_command_remote(
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

    async def fake_use_remote(_frame, _redis, _transport):
        return False

    async def fake_get_ssh_connection(_db, _redis, _frame):
        ssh = FakeSSH()
        connections.append(ssh)
        return ssh

    async def fake_remove_ssh_connection(_db, _redis, _ssh, _frame):
        pass

    async def fake_log(_db, _redis, _frame_id, log_type, line, timestamp=None):
        logged.append((log_type, line))

    monkeypatch.setattr(remote_exec, "_use_remote", fake_use_remote)
    monkeypatch.setattr(remote_exec, "get_ssh_connection", fake_get_ssh_connection)
    monkeypatch.setattr(remote_exec, "remove_ssh_connection", fake_remove_ssh_connection)
    monkeypatch.setattr(remote_exec, "log", fake_log)
    monkeypatch.setattr(remote_exec.asyncssh, "scp", scp_impl)
    # Keep stall detection fast: the watchdog polls every second, so a hanging
    # transfer is declared stalled on its first check.
    monkeypatch.setattr(remote_exec, "SCP_STALL_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(remote_exec, "SCP_MAX_ATTEMPTS", 2)
    return connections


def _patch_remote_upload_env(monkeypatch, logged):
    async def fake_use_remote(_frame, _redis, _transport):
        return True

    async def fake_log(_db, _redis, _frame_id, log_type, line, timestamp=None):
        logged.append((log_type, line))

    monkeypatch.setattr(remote_exec, "_use_remote", fake_use_remote)
    monkeypatch.setattr(remote_exec, "log", fake_log)


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


@pytest.mark.asyncio
async def test_upload_file_remote_stream_falls_back_to_shell_upload(monkeypatch):
    logged: list[tuple[str, str]] = []
    shell_uploads: list[tuple[str, bytes, int]] = []
    frame = SimpleNamespace(id=1, agent={"agentEnabled": True, "agentRunCommands": True})
    _patch_remote_upload_env(monkeypatch, logged)

    async def fake_stream_file(_db, _redis, _frame, _remote_path, _data, timeout=120):
        raise RuntimeError("file_write_chunk failed: file_write_open missing")

    async def fake_shell_upload(_db, _redis, _frame, remote_path, data, timeout):
        shell_uploads.append((remote_path, data, timeout))

    monkeypatch.setattr(remote_exec, "_stream_file_via_remote", fake_stream_file)
    monkeypatch.setattr(remote_exec, "_shell_upload_via_remote", fake_shell_upload)

    await remote_exec.upload_file(None, None, frame, "/tmp/target", b"data", timeout=1800)

    assert shell_uploads == [("/tmp/target", b"data", 1800)]
    assert any("remote streaming upload unavailable" in line for _t, line in logged)


@pytest.mark.asyncio
async def test_upload_file_remote_stream_non_capability_errors_still_raise(monkeypatch):
    logged: list[tuple[str, str]] = []
    shell_uploads: list[tuple[str, bytes, int]] = []
    frame = SimpleNamespace(id=1, agent={"agentEnabled": True, "agentRunCommands": True})
    _patch_remote_upload_env(monkeypatch, logged)

    async def fake_stream_file(_db, _redis, _frame, _remote_path, _data, timeout=120):
        raise RuntimeError("file_write_open failed: Permission denied")

    async def fake_shell_upload(_db, _redis, _frame, remote_path, data, timeout):
        shell_uploads.append((remote_path, data, timeout))

    monkeypatch.setattr(remote_exec, "_stream_file_via_remote", fake_stream_file)
    monkeypatch.setattr(remote_exec, "_shell_upload_via_remote", fake_shell_upload)

    with pytest.raises(RuntimeError, match="Permission denied"):
        await remote_exec.upload_file(None, None, frame, "/tmp/target", b"data")

    assert shell_uploads == []
    assert any("ERROR writing /tmp/target" in line for _t, line in logged)


@pytest.mark.asyncio
async def test_shell_upload_via_remote_writes_base64_chunks(monkeypatch):
    logged: list[tuple[str, str]] = []
    commands: list[str] = []
    frame = SimpleNamespace(id=7)

    async def fake_exec(_redis, _frame, cmd, _timeout):
        commands.append(cmd)

    async def fake_log(_db, _redis, _frame_id, log_type, line, timestamp=None):
        logged.append((log_type, line))

    monkeypatch.setattr(remote_exec, "_exec_via_remote", fake_exec)
    monkeypatch.setattr(remote_exec, "log", fake_log)
    monkeypatch.setattr(remote_exec, "SHELL_UPLOAD_BASE64_CHUNK_SIZE", 4)

    await remote_exec._shell_upload_via_remote(None, None, frame, "/srv/frameos/remote/bin", b"hello", 30)

    assert commands[0].startswith("set -eu; mkdir -p /srv/frameos/remote; : > ")
    assert "printf %s aGVs >>" in commands[1]
    assert "printf %s bG8= >>" in commands[2]
    assert "base64 -d" in commands[3]
    assert "mv " in commands[3]
    assert any("falling back to shell/base64 upload" in line for _t, line in logged)
