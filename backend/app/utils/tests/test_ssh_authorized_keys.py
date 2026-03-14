from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.utils.ssh_authorized_keys import _install_authorized_keys


@pytest.mark.asyncio
async def test_install_authorized_keys_runs_quietly(monkeypatch: pytest.MonkeyPatch):
    uploads: list[tuple[str, bytes, dict]] = []
    commands: list[tuple[list[str], dict]] = []

    async def fake_upload_file(_db, _redis, _frame, remote_path: str, data: bytes, **kwargs):
        uploads.append((remote_path, data, kwargs))

    async def fake_run_commands(_db, _redis, _frame, command_list: list[str], **kwargs):
        commands.append((command_list, kwargs))

    monkeypatch.setattr("app.utils.ssh_authorized_keys.upload_file", fake_upload_file)
    monkeypatch.setattr("app.utils.ssh_authorized_keys.run_commands", fake_run_commands)

    frame = SimpleNamespace(id=1, ssh_user="marius")

    await _install_authorized_keys(
        db=None,
        redis=None,
        frame=frame,
        public_keys=["ssh-ed25519 AAA first", "ssh-ed25519 AAA first", "ssh-rsa BBB second"],
        known_public_keys=["ssh-ed25519 AAA first", "ssh-rsa BBB second"],
    )

    assert len(uploads) == 2
    assert uploads[0][2]["log_transfer"] is False
    assert uploads[0][2]["log_connection"] is False
    assert uploads[1][2]["log_transfer"] is False
    assert uploads[1][2]["log_connection"] is False
    assert len(commands) == 1
    assert len(commands[0][0]) == 1
    assert commands[0][1] == {
        "log_output": False,
        "log_command": False,
        "log_connection": False,
    }
    assert "authorized_keys" in commands[0][0][0]
    assert "frameos_authorized_keys_" in uploads[0][0]
    assert "frameos_known_authorized_keys_" in uploads[1][0]
    assert uploads[0][1] == b"ssh-ed25519 AAA first\nssh-rsa BBB second\n"
