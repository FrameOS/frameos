from __future__ import annotations

import asyncio
import json
import os
import stat
from types import SimpleNamespace
from typing import Any

import pytest

from app.utils import remote_exec, ssh_utils
from app.ws.remote_ws import shell_command_payload

# The calls below pass None for db/redis and SimpleNamespace frames; the
# module is reached untyped so mypy does not flag every stand-in.
rx: Any = remote_exec


def _ssh_frame() -> Any:
    return SimpleNamespace(id=5, agent={}, frame_host="frame.local", ssh_user="pi")


@pytest.mark.asyncio
async def test_run_commands_forwards_the_timeout_on_the_ssh_path(monkeypatch: pytest.MonkeyPatch):
    seen: list[tuple[str, int]] = []

    async def fake_get_ssh_connection(_db, _redis, _frame):
        return object()

    async def fake_remove_ssh_connection(_db, _redis, _ssh, _frame):
        return None

    async def fake_exec_command(_db, _redis, _frame, _ssh, cmd, **kwargs):
        seen.append((cmd, kwargs["timeout"]))
        return 0

    monkeypatch.setattr(remote_exec, "get_ssh_connection", fake_get_ssh_connection)
    monkeypatch.setattr(remote_exec, "remove_ssh_connection", fake_remove_ssh_connection)
    monkeypatch.setattr(remote_exec, "exec_command", fake_exec_command)

    await rx.run_commands(None, None, _ssh_frame(), ["a", "b"], timeout=7, transport="ssh")
    await rx.make_dir(None, None, _ssh_frame(), "/tmp/x", timeout=9, transport="ssh")

    assert seen == [("a", 7), ("b", 7), ("mkdir -p /tmp/x", 9)]


class _HangingProcess:
    def __init__(self) -> None:
        self.killed = False
        empty = SimpleNamespace(readline=self._eof)
        self.stdout = empty
        self.stderr = empty

    @staticmethod
    async def _eof():
        return b""

    async def wait(self):
        await asyncio.sleep(60)

    def kill(self) -> None:
        self.killed = True


@pytest.mark.asyncio
async def test_ssh_exec_command_kills_and_raises_timeout_error():
    process = _HangingProcess()

    async def create_process(_command):
        return process

    ssh = SimpleNamespace(create_process=create_process)

    with pytest.raises(TimeoutError, match="timed out after 0.05s"):
        await ssh_utils.exec_command(None, None, _ssh_frame(), ssh, "sleep 999", log_command=False, timeout=0.05)  # type: ignore[arg-type]

    assert process.killed


def test_remote_shell_payload_carries_the_timeout():
    assert shell_command_payload("uptime", 45) == {
        "type": "cmd",
        "name": "shell",
        "args": {"cmd": "uptime", "timeout": 45},
    }
    # 0 would mean "use the Remote's 1800 s default".
    assert shell_command_payload("uptime", 0.2)["args"]["timeout"] == 1


class _AnsweringRedis:
    def __init__(self) -> None:
        self.pushed: list[dict] = []

    async def rpush(self, _key: str, value: bytes) -> None:
        self.pushed.append(json.loads(value))

    async def blpop(self, key, timeout=None):
        return key.encode(), json.dumps({"ok": True, "result": {"exit": 0}}).encode()


@pytest.mark.asyncio
async def test_exec_via_remote_sends_the_timeout_to_the_remote():
    redis = _AnsweringRedis()

    await rx._exec_via_remote(redis, SimpleNamespace(id=41), "sleep 1", 300)  # type: ignore[arg-type]

    assert redis.pushed[0]["payload"]["args"] == {"cmd": "sleep 1", "timeout": 300}


@pytest.mark.asyncio
async def test_private_shell_upload_never_leaves_the_file_world_readable(monkeypatch: pytest.MonkeyPatch):
    commands: list[str] = []

    async def fake_exec(_redis, _frame, cmd, _timeout):
        commands.append(cmd)

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(remote_exec, "_exec_via_remote", fake_exec)
    monkeypatch.setattr(remote_exec, "log", fake_log)

    await rx._shell_upload_via_remote(
        None, None, SimpleNamespace(id=7), "/srv/frameos/current/frame.json", b"{}", 30, mode=0o600
    )

    finalize = commands[-1]
    assert finalize.startswith("set -eu; umask 077; ")
    assert finalize.index("chmod 600 ") < finalize.index("mv ")


@pytest.mark.asyncio
async def test_default_shell_upload_is_unchanged(monkeypatch: pytest.MonkeyPatch):
    commands: list[str] = []

    async def fake_exec(_redis, _frame, cmd, _timeout):
        commands.append(cmd)

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(remote_exec, "_exec_via_remote", fake_exec)
    monkeypatch.setattr(remote_exec, "log", fake_log)

    await rx._shell_upload_via_remote(None, None, SimpleNamespace(id=7), "/tmp/scene.json", b"{}", 30)

    assert "umask" not in commands[-1] and "chmod" not in commands[-1]


@pytest.mark.asyncio
async def test_stream_upload_with_a_mode_chmods_after_close(monkeypatch: pytest.MonkeyPatch):
    commands: list[str] = []
    frame = SimpleNamespace(id=8, agent={"remoteCapabilities": {"fileWriteStream": True}})

    async def use_remote(*_args, **_kwargs):
        return True

    async def fake_stream(*_args, **_kwargs):
        return None

    async def fake_exec(_redis, _frame, cmd, _timeout):
        commands.append(cmd)

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(remote_exec, "_use_remote", use_remote)
    monkeypatch.setattr(remote_exec, "_stream_file_via_remote", fake_stream)
    monkeypatch.setattr(remote_exec, "_exec_via_remote", fake_exec)
    monkeypatch.setattr(remote_exec, "log", fake_log)

    await rx.upload_file(None, None, frame, "/srv/frameos/frame.json", b"{}", mode=0o600)

    assert commands == ["chmod 600 /srv/frameos/frame.json"]


@pytest.mark.asyncio
async def test_scp_upload_carries_the_mode_on_the_local_temp_file(monkeypatch: pytest.MonkeyPatch):
    modes: list[int] = []

    async def fake_get_ssh_connection(_db, _redis, _frame):
        return SimpleNamespace(abort=lambda: None)

    async def fake_remove_ssh_connection(*_args):
        return None

    async def fake_scp(_db, _redis, _frame, _ssh, local_path, _remote_path, _size):
        modes.append(stat.S_IMODE(os.stat(local_path).st_mode))

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(remote_exec, "get_ssh_connection", fake_get_ssh_connection)
    monkeypatch.setattr(remote_exec, "remove_ssh_connection", fake_remove_ssh_connection)
    monkeypatch.setattr(remote_exec, "_scp_with_progress", fake_scp)
    monkeypatch.setattr(remote_exec, "log", fake_log)

    await rx.upload_file(None, None, _ssh_frame(), "/srv/frameos/frame.json", b"{}", transport="ssh", mode=0o600)

    assert modes == [0o600]
