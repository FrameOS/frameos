import gzip
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks import frame_deploy_helpers
from app.tasks.frame_deploy_helpers import (
    RPIOS_SUDO_SECURITY_UPDATE_URL,
    ensure_sudo_available,
    upload_binary,
    upload_directory_tree,
)


class RecordingDeployer:
    def __init__(self):
        self.db = None
        self.redis = None
        self.frame = SimpleNamespace(id=1)
        self.commands: list[str] = []
        self.logs: list[tuple[str, str]] = []

    async def exec_command(self, command: str, **_kwargs) -> int:
        self.commands.append(command)
        return 0

    async def log(self, log_type: str, message: str) -> None:
        self.logs.append((log_type, message))


class SudoCheckDeployer:
    def __init__(
        self,
        *,
        sudo_status: int = 0,
    ):
        self.frame = SimpleNamespace(id=1)
        self.commands: list[tuple[str, dict]] = []
        self.logs: list[tuple[str, str]] = []
        self.sudo_status = sudo_status

    async def exec_command(self, command: str, **kwargs) -> int:
        self.commands.append((command, kwargs))
        if command == "sudo -n true":
            return self.sudo_status
        raise AssertionError(f"Unexpected command: {command}")

    async def log(self, log_type: str, message: str) -> None:
        self.logs.append((log_type, message))


@pytest.mark.asyncio
async def test_upload_directory_tree_preserves_requested_remote_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    uploads: list[tuple[str, bytes]] = []

    async def fake_upload_file(_db, _redis, _frame, remote_path: str, data: bytes):
        uploads.append((remote_path, data))

    monkeypatch.setattr(frame_deploy_helpers, "upload_file", fake_upload_file)

    local_dir = tmp_path / "inkyPython"
    local_dir.mkdir()
    (local_dir / "requirements.txt").write_text("inky==2.2.1\n", encoding="utf-8")
    deployer = RecordingDeployer()

    await upload_directory_tree(
        deployer,
        str(local_dir),
        "/srv/frameos/vendor/inkyPython",
        "inkyPython vendor files",
        "build12345678",
        preserve_remote_paths=("env", "requirements.txt.sha256sum"),
    )

    assert uploads
    assert uploads[0][0] == "/tmp/inkyPython_build12345678.tar.gz"
    preserve_env = next(
        i for i, command in enumerate(deployer.commands) if "mv /srv/frameos/vendor/inkyPython/env " in command
    )
    preserve_checksum = next(
        i
        for i, command in enumerate(deployer.commands)
        if "mv /srv/frameos/vendor/inkyPython/requirements.txt.sha256sum " in command
    )
    delete_vendor = deployer.commands.index("rm -rf /srv/frameos/vendor/inkyPython")
    extract_vendor = next(
        i
        for i, command in enumerate(deployer.commands)
        if command.startswith("tar -xzf /tmp/inkyPython_build12345678.tar.gz ")
    )
    restore_env = next(
        i for i, command in enumerate(deployer.commands) if "mv /tmp/inkyPython_build12345678_preserve/env " in command
    )
    restore_checksum = next(
        i
        for i, command in enumerate(deployer.commands)
        if "mv /tmp/inkyPython_build12345678_preserve/requirements.txt.sha256sum " in command
    )

    assert preserve_env < delete_vendor
    assert preserve_checksum < delete_vendor
    assert delete_vendor < extract_vendor
    assert extract_vendor < restore_env
    assert extract_vendor < restore_checksum
    assert deployer.commands[-1] == "rm -rf /tmp/inkyPython_build12345678_preserve"


@pytest.mark.asyncio
async def test_upload_binary_sends_gzip_archive_and_verifies_before_move(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    uploads: list[tuple[str, bytes]] = []

    async def fake_upload_file(_db, _redis, _frame, remote_path: str, data: bytes):
        uploads.append((remote_path, data))

    monkeypatch.setattr(frame_deploy_helpers, "upload_file", fake_upload_file)

    local_binary = tmp_path / "frameos"
    local_binary.write_bytes(b"frameos-binary" * 1024)
    deployer = RecordingDeployer()

    await upload_binary(deployer, str(local_binary), "/srv/frameos/releases/release_1/frameos")

    assert uploads
    assert uploads[0][0] == "/srv/frameos/releases/release_1/frameos.manual.upload.gz"
    assert gzip.decompress(uploads[0][1]) == local_binary.read_bytes()
    assert deployer.commands[0] == "mkdir -p /srv/frameos/releases/release_1"
    install_command = deployer.commands[1]
    assert 'gzip -dc "$archive" > "$tmp"' in install_command
    assert "sha256sum -c -" in install_command
    assert 'mv "$tmp" "$target"' in install_command
    assert any("Uploading compressed binary" in message for _log_type, message in deployer.logs)


@pytest.mark.asyncio
async def test_ensure_sudo_available_passes_when_sudo_already_works():
    deployer = SudoCheckDeployer(sudo_status=0)

    await ensure_sudo_available(deployer)

    assert [command for command, _kwargs in deployer.commands] == ["sudo -n true"]
    assert deployer.logs == []


@pytest.mark.asyncio
async def test_ensure_sudo_available_blocks_with_rpios_message_when_sudo_requires_password():
    deployer = SudoCheckDeployer(sudo_status=1)

    with pytest.raises(RuntimeError, match="requires non-interactive sudo") as exc:
        await ensure_sudo_available(deployer)

    assert RPIOS_SUDO_SECURITY_UPDATE_URL in str(exc.value)
    assert "sudo raspi-config" in str(exc.value)
    assert [command for command, _kwargs in deployer.commands] == ["sudo -n true"]
    assert deployer.logs == []
