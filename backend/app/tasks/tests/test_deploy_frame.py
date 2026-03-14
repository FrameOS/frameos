import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.deploy_frame import _build_remote_compiled_scenes, _local_compiled_scene_artifact_dir


def test_local_compiled_scene_artifact_dir_requires_shared_library(tmp_path: Path):
    build_dir = tmp_path / "build"
    scenes_dir = build_dir / "scenes"
    scenes_dir.mkdir(parents=True)
    (scenes_dir / "readme.txt").write_text("not a plugin\n", encoding="utf-8")

    assert _local_compiled_scene_artifact_dir(str(build_dir)) is None


def test_local_compiled_scene_artifact_dir_returns_scenes_dir_when_plugins_exist(tmp_path: Path):
    build_dir = tmp_path / "build"
    scenes_dir = build_dir / "scenes"
    scenes_dir.mkdir(parents=True)
    (scenes_dir / "demo.so").write_bytes(b"plugin")

    assert _local_compiled_scene_artifact_dir(str(build_dir)) == str(scenes_dir)


def test_deploy_frame_imports_current_frameos_version():
    deploy_frame_module = importlib.import_module("app.tasks.deploy_frame")
    assert callable(deploy_frame_module.current_frameos_version)


@pytest.mark.asyncio
async def test_build_remote_compiled_scenes_does_not_stage_quickjs():
    commands: list[str] = []
    logs: list[tuple[str, str]] = []

    async def fake_log(level: str, message: str) -> None:
        logs.append((level, message))

    async def fake_exec(command: str, **_kwargs) -> None:
        commands.append(command)

    deployer = SimpleNamespace(
        log=fake_log,
        exec_command=fake_exec,
    )

    await _build_remote_compiled_scenes(
        deployer,
        "/srv/frameos/build/build_abc",
        scene_build_dirs=["scene_builds/demo"],
    )

    assert len(logs) == 1
    assert logs[0][0] == "stdout"
    assert "Building compiled scene plugins on remote" in logs[0][1]
    assert len(commands) == 1
    assert "make --no-print-directory -C \"$dir\"" in commands[0]
    assert "quickjs" not in commands[0]
