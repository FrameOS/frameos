import importlib
from pathlib import Path

from app.tasks.deploy_frame import _local_compiled_scene_artifact_dir


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
