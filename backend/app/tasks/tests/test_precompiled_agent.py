from __future__ import annotations

import shutil
import tarfile
from pathlib import Path

import pytest

from app.tasks.precompiled_agent import (
    download_precompiled_agent_release,
    precompiled_agent_release_url,
)
from app.tasks.precompiled_frameos import release_version


def test_precompiled_agent_release_url_uses_release_version():
    version = release_version()
    assert version

    url = precompiled_agent_release_url("debian-trixie-arm64")

    assert url is not None
    assert url.endswith(f"/v{version}/frameos-agent-{version}-debian-trixie-arm64.tar.gz")


@pytest.mark.asyncio
async def test_download_precompiled_agent_release_extracts_binary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_root = tmp_path / "source" / "prebuilt-cross" / "debian-trixie-arm64"
    source_root.mkdir(parents=True)
    (source_root / "frameos_agent").write_bytes(b"agent")
    (source_root / "metadata.json").write_text(
        '{"slug":"debian-trixie-arm64","agent_binary":"frameos_agent"}\n',
        encoding="utf-8",
    )
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(tmp_path / "source" / "prebuilt-cross", arcname="prebuilt-cross")

    async def fake_download(_url: str, destination: Path, _timeout: float) -> None:
        shutil.copy2(archive, destination)

    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    result = await download_precompiled_agent_release(
        target="debian-trixie-arm64",
        build_dir=str(tmp_path / "build"),
        temp_dir=str(tmp_path),
        build_id="agent1234567",
        logger=logger,
    )

    assert Path(result.binary_path).read_bytes() == b"agent"
    assert Path(result.archive_path).is_file()
    assert result.cache_hit is False
    assert any("Downloading precompiled FrameOS agent release" in message for _level, message in logs)
