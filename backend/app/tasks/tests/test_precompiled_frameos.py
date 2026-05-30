from __future__ import annotations

import shutil
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.precompiled_frameos import download_precompiled_frameos_release, frame_compiled_scene_count


def test_frame_compiled_scene_count_treats_missing_execution_as_compiled():
    frame = SimpleNamespace(
        scenes=[
            {"settings": {"execution": "interpreted"}},
            {"settings": {"execution": "compiled"}},
            {"settings": {}},
        ]
    )

    assert frame_compiled_scene_count(frame) == 2


@pytest.mark.asyncio
async def test_download_precompiled_frameos_release_extracts_required_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_root = tmp_path / "source" / "frameos-2026.5.14-debian-trixie-arm64"
    (source_root / "drivers").mkdir(parents=True)
    (source_root / "scenes").mkdir(parents=True)
    (source_root / "frameos").write_bytes(b"frameos")
    (source_root / "drivers" / "frameBuffer.so").write_bytes(b"driver")
    (source_root / "drivers" / "evdev.so").write_bytes(b"evdev")
    (source_root / "scenes" / "scenes.so").write_bytes(b"scenes")
    (source_root / "metadata.json").write_text(
        (
            '{"slug":"debian-trixie-arm64","driver_libraries":["evdev.so","frameBuffer.so"],'
            '"scene_libraries":["scenes.so"]}\n'
        ),
        encoding="utf-8",
    )
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname=source_root.name)

    async def fake_download(_url: str, destination: Path, _timeout: float) -> None:
        shutil.copy2(archive, destination)

    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    build_dir = tmp_path / "build"
    result = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(build_dir),
        temp_dir=str(tmp_path),
        build_id="build12345678",
        logger=logger,
    )

    assert Path(result.binary_path).read_bytes() == b"frameos"
    assert result.driver_library_names == ["frameBuffer.so", "evdev.so"]
    assert result.scene_library_names == ["scenes.so"]
    assert [Path(path).read_bytes() for path in result.driver_library_paths] == [b"driver", b"evdev"]
    assert [Path(path).read_bytes() for path in result.scene_library_paths] == [b"scenes"]
    assert Path(result.archive_path).is_file()
    assert result.cache_hit is False
    assert any("Downloading precompiled FrameOS release" in message for _level, message in logs)


@pytest.mark.asyncio
async def test_download_precompiled_frameos_release_reuses_cached_archive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_root = tmp_path / "source" / "frameos-2026.5.14-debian-trixie-arm64"
    (source_root / "drivers").mkdir(parents=True)
    (source_root / "scenes").mkdir(parents=True)
    (source_root / "frameos").write_bytes(b"frameos")
    (source_root / "drivers" / "frameBuffer.so").write_bytes(b"driver")
    (source_root / "drivers" / "evdev.so").write_bytes(b"evdev")
    (source_root / "scenes" / "scenes.so").write_bytes(b"scenes")
    (source_root / "metadata.json").write_text(
        (
            '{"slug":"debian-trixie-arm64","driver_libraries":["evdev.so","frameBuffer.so"],'
            '"scene_libraries":["scenes.so"]}\n'
        ),
        encoding="utf-8",
    )
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname=source_root.name)

    download_count = 0

    async def fake_download(_url: str, destination: Path, _timeout: float) -> None:
        nonlocal download_count
        download_count += 1
        shutil.copy2(archive, destination)

    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    first = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(tmp_path / "build-first"),
        temp_dir=str(tmp_path),
        build_id="first1234567",
        logger=logger,
    )
    second = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(tmp_path / "build-second"),
        temp_dir=str(tmp_path),
        build_id="second123456",
        logger=logger,
    )

    assert download_count == 1
    assert first.cache_hit is False
    assert second.cache_hit is True
    assert Path(second.binary_path).read_bytes() == b"frameos"
    assert first.scene_library_names == ["scenes.so"]
    assert second.scene_library_names == ["scenes.so"]
    assert [Path(path).read_bytes() for path in second.scene_library_paths] == [b"scenes"]
    assert any("Using cached precompiled FrameOS release" in message for _level, message in logs)
