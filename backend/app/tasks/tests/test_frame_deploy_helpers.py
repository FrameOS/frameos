from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks import frame_deploy_helpers
from app.tasks.frame_deploy_helpers import upload_directory_tree


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
