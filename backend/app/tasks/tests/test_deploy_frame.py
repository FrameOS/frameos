import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.tasks.compile_manifest import CompileManifest, CompilePlan, DriverCompileState, SceneCompileState
from app.tasks.deploy_frame import (
    _adjust_compile_plan_for_missing_remote_artifacts,
    _build_remote_compiled_scenes,
    _build_remote_compiled_drivers,
    _compile_plan_log_lines,
    _ensure_quickjs_for_remote_frameos_build,
    _local_compiled_driver_artifact_dir,
    _local_compiled_scene_artifact_dir,
    _local_vendor_source_dir,
    _upload_local_compiled_drivers,
    _scene_compile_start_lines,
    _sync_vendor_dir,
    _upload_local_compiled_scenes,
)

deploy_frame_module = importlib.import_module("app.tasks.deploy_frame")


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


def test_local_compiled_driver_artifact_dir_returns_drivers_dir_when_plugins_exist(tmp_path: Path):
    build_dir = tmp_path / "build"
    drivers_dir = build_dir / "drivers"
    drivers_dir.mkdir(parents=True)
    (drivers_dir / "frameBuffer.so").write_bytes(b"plugin")

    assert _local_compiled_driver_artifact_dir(str(build_dir)) == str(drivers_dir)


def test_local_vendor_source_dir_falls_back_to_repo_vendor_when_build_dir_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    vendor_root = tmp_path / "vendor"
    vendor_dir = vendor_root / "inky"
    vendor_dir.mkdir(parents=True)
    monkeypatch.setattr(deploy_frame_module, "LOCAL_FRAMEOS_VENDOR_ROOT", vendor_root)

    assert _local_vendor_source_dir(None, "inky") == str(vendor_dir)


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

    assert len(logs) == 2
    assert logs[0][0] == "stdout"
    assert "Scene compile: building 1 scene on device" in logs[0][1]
    assert logs[1][0] == "stdout"
    assert "Scene compile: completed on device" in logs[1][1]
    assert len(commands) == 1
    assert "make --no-print-directory -C \"$dir\"" in commands[0]
    assert "quickjs" not in commands[0]


@pytest.mark.asyncio
async def test_build_remote_compiled_drivers_builds_requested_driver_dirs():
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

    await _build_remote_compiled_drivers(
        deployer,
        "/srv/frameos/build/build_abc",
        driver_build_dirs=["driver_builds/frameBuffer"],
        driver_ids=("frameBuffer",),
    )

    assert logs == [
        ("stdout", "🔷 Driver compile: building 1 driver on device"),
        ("stdout", "🔷 Compiling driver: frameBuffer"),
        ("stdout", "🔷 Driver compile: completed on device"),
    ]
    assert len(commands) == 1
    assert "mkdir -p drivers" in commands[0]
    assert "make --no-print-directory -C \"$dir\"" in commands[0]


@pytest.mark.asyncio
async def test_upload_local_compiled_scenes_merges_into_existing_release(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[tuple, dict]] = []

    async def fake_upload_directory_tree(*args, **kwargs):
        calls.append((args, kwargs))

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(deploy_frame_module, "_upload_directory_tree", fake_upload_directory_tree)

    await _upload_local_compiled_scenes(
        SimpleNamespace(log=fake_log),
        "/tmp/local-scenes",
        "/srv/frameos/releases/release_x/scenes",
        "build123",
    )

    assert len(calls) == 1
    assert calls[0][0][1:] == (
        "/tmp/local-scenes",
        "/srv/frameos/releases/release_x/scenes",
        "compiled scenes",
        "build123",
    )
    assert calls[0][1] == {"replace": False}


@pytest.mark.asyncio
async def test_upload_local_compiled_drivers_merges_into_existing_release(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[tuple, dict]] = []

    async def fake_upload_directory_tree(*args, **kwargs):
        calls.append((args, kwargs))

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr(deploy_frame_module, "_upload_directory_tree", fake_upload_directory_tree)

    await _upload_local_compiled_drivers(
        SimpleNamespace(log=fake_log),
        "/tmp/local-drivers",
        "/srv/frameos/releases/release_x/drivers",
        "build123",
    )

    assert len(calls) == 1
    assert calls[0][0][1:] == (
        "/tmp/local-drivers",
        "/srv/frameos/releases/release_x/drivers",
        "compiled drivers",
        "build123",
    )
    assert calls[0][1] == {"replace": False}


@pytest.mark.asyncio
async def test_sync_vendor_dir_reuses_existing_remote_vendor_when_build_was_skipped(
    monkeypatch: pytest.MonkeyPatch,
):
    upload_directory_tree = AsyncMock()
    monkeypatch.setattr(deploy_frame_module, "_upload_directory_tree", upload_directory_tree)
    monkeypatch.setattr(deploy_frame_module, "_remote_dir_exists", AsyncMock(return_value=True))

    logs: list[tuple[str, str]] = []

    async def fake_log(level: str, message: str) -> None:
        logs.append((level, message))

    deployer = SimpleNamespace(log=fake_log)

    await _sync_vendor_dir(
        deployer,
        None,
        "inky",
        "inkyPython vendor files",
        "build123",
        reuse_existing_remote=True,
    )

    upload_directory_tree.assert_not_awaited()
    assert logs == [("stdout", "🔷 Reusing existing inkyPython vendor files")]


@pytest.mark.asyncio
async def test_sync_vendor_dir_uploads_local_vendor_when_remote_copy_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    local_vendor = tmp_path / "inky"
    local_vendor.mkdir()

    upload_directory_tree = AsyncMock()
    monkeypatch.setattr(deploy_frame_module, "_upload_directory_tree", upload_directory_tree)
    monkeypatch.setattr(deploy_frame_module, "_remote_dir_exists", AsyncMock(return_value=False))

    deployer = SimpleNamespace(log=AsyncMock())

    await _sync_vendor_dir(
        deployer,
        str(local_vendor),
        "inky",
        "inkyPython vendor files",
        "build123",
        reuse_existing_remote=True,
    )

    upload_directory_tree.assert_awaited_once_with(
        deployer,
        str(local_vendor),
        "/srv/frameos/vendor/inky",
        "inkyPython vendor files",
        "build123",
    )


@pytest.mark.asyncio
async def test_ensure_quickjs_for_remote_frameos_build_skips_scene_only_and_cross_compiled_paths(
    monkeypatch: pytest.MonkeyPatch,
):
    ensure_quickjs = AsyncMock(return_value="quickjs-dir")
    monkeypatch.setattr(deploy_frame_module, "_ensure_quickjs", ensure_quickjs)

    deployer = SimpleNamespace()

    assert (
        await _ensure_quickjs_for_remote_frameos_build(
            deployer,
            prebuilt_entry=None,
            build_id="build123",
            rebuild_app=False,
            cross_compiled=False,
        )
        is None
    )
    assert (
        await _ensure_quickjs_for_remote_frameos_build(
            deployer,
            prebuilt_entry=None,
            build_id="build123",
            rebuild_app=True,
            cross_compiled=True,
        )
        is None
    )
    ensure_quickjs.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_quickjs_for_remote_frameos_build_runs_for_on_device_binary_build(
    monkeypatch: pytest.MonkeyPatch,
):
    ensure_quickjs = AsyncMock(return_value="quickjs-dir")
    monkeypatch.setattr(deploy_frame_module, "_ensure_quickjs", ensure_quickjs)

    deployer = SimpleNamespace()

    result = await _ensure_quickjs_for_remote_frameos_build(
        deployer,
        prebuilt_entry=None,
        build_id="build123",
        rebuild_app=True,
        cross_compiled=False,
    )

    assert result == "quickjs-dir"
    ensure_quickjs.assert_awaited_once_with(
        deployer,
        prebuilt_entry=None,
        build_id="build123",
        cross_compiled=False,
    )


def test_compile_plan_log_lines_for_scene_only_rebuild_include_skip_reason_and_scene_name():
    frame = SimpleNamespace(
        scenes=[
            {"id": "demo-scene-id", "name": "Calendar"},
            {"id": "kept-scene-id", "name": "Weather"},
        ]
    )
    compile_plan = CompilePlan(
        mode="smart",
        rebuild_app=False,
        rebuild_scene_ids=("demo-scene-id",),
        reuse_scene_ids=("kept-scene-id",),
        rebuild_driver_ids=("frameBuffer",),
        reuse_driver_ids=("gpioButton",),
        reason="Compiled scene inputs changed",
    )
    manifest = CompileManifest(
        version=1,
        frameos_version="1.0.0",
        runtime_contract_hash="runtime",
        app_hash="app",
        scene_hashes={
            "demo-scene-id": SceneCompileState(hash="a", library="demo.so"),
            "kept-scene-id": SceneCompileState(hash="b", library="kept.so"),
        },
        driver_hashes={
            "frameBuffer": DriverCompileState(hash="c", library="frameBuffer.so"),
            "gpioButton": DriverCompileState(hash="d", library="gpioButton.so"),
        },
    )

    lines = _compile_plan_log_lines(frame, compile_plan, manifest)

    assert lines == [
        "🔷 Compile plan: Compiled scene inputs changed",
        "🔷 FrameOS compile: skipped (app inputs unchanged)",
        "🔷 Scene compile: requested (1 changed, reusing 1)",
        "🔷 Scenes to compile: Calendar (demo-sce...)",
        "🔷 Driver compile: requested (1 changed, reusing 1)",
        "🔷 Drivers to compile: frameBuffer",
    ]


def test_compile_plan_log_lines_report_absence_of_compiled_scenes():
    frame = SimpleNamespace(scenes=[{"id": "interpreted-only", "settings": {"execution": "interpreted"}}])
    compile_plan = CompilePlan(
        mode="smart",
        rebuild_app=False,
        rebuild_scene_ids=(),
        reuse_scene_ids=(),
        rebuild_driver_ids=(),
        reuse_driver_ids=(),
        reason="Compile inputs unchanged",
    )
    manifest = CompileManifest(
        version=1,
        frameos_version="1.0.0",
        runtime_contract_hash="runtime",
        app_hash="app",
        scene_hashes={},
        driver_hashes={},
    )

    lines = _compile_plan_log_lines(frame, compile_plan, manifest)

    assert lines == [
        "🔷 Compile plan: Compile inputs unchanged",
        "🔷 FrameOS compile: skipped (inputs unchanged)",
        "🔷 Scene compile: skipped (no compiled scenes configured)",
        "🔷 Driver compile: skipped (no compiled drivers configured)",
    ]


def test_scene_compile_start_lines_emit_one_line_per_scene():
    frame = SimpleNamespace(
        scenes=[
            {"id": "demo-scene-id", "name": "Calendar"},
            {"id": "other-scene-id", "name": "Weather"},
        ]
    )

    lines = _scene_compile_start_lines(frame, ("demo-scene-id", "other-scene-id"))

    assert lines == [
        "🔷 Compiling scene: Calendar (demo-sce...)",
        "🔷 Compiling scene: Weather (other-sc...)",
    ]


@pytest.mark.asyncio
async def test_adjust_compile_plan_for_missing_remote_scene_plugin_marks_scene_for_rebuild():
    commands: list[str] = []

    async def fake_exec(command: str, **_kwargs):
        commands.append(command)
        if "demo.so" in command or "frameBuffer.so" in command:
            return 1
        return 0

    deployer = SimpleNamespace(exec_command=fake_exec)
    compile_plan = CompilePlan(
        mode="smart",
        rebuild_app=False,
        rebuild_scene_ids=(),
        reuse_scene_ids=("demo", "kept"),
        rebuild_driver_ids=(),
        reuse_driver_ids=("frameBuffer",),
        reason="Compile inputs unchanged",
    )
    manifest = CompileManifest(
        version=1,
        frameos_version="1.0.0",
        runtime_contract_hash="runtime",
        app_hash="app",
        scene_hashes={
            "demo": SceneCompileState(hash="a", library="demo.so"),
            "kept": SceneCompileState(hash="b", library="kept.so"),
        },
        driver_hashes={
            "frameBuffer": DriverCompileState(hash="c", library="frameBuffer.so"),
        },
    )

    adjusted = await _adjust_compile_plan_for_missing_remote_artifacts(
        deployer,
        compile_plan,
        manifest,
    )

    assert adjusted.rebuild_app is False
    assert adjusted.rebuild_scene_ids == ("demo",)
    assert adjusted.reuse_scene_ids == ("kept",)
    assert adjusted.rebuild_driver_ids == ("frameBuffer",)
    assert adjusted.reuse_driver_ids == ()
    assert adjusted.reason == "Compile inputs unchanged; 1 cached scene missing on device; 1 cached driver missing on device"
    assert commands == [
        "test -f /srv/frameos/current/frameos",
        "test -f /srv/frameos/current/scenes/demo.so",
        "test -f /srv/frameos/current/scenes/kept.so",
        "test -f /srv/frameos/current/drivers/frameBuffer.so",
    ]


@pytest.mark.asyncio
async def test_adjust_compile_plan_for_missing_remote_binary_marks_app_for_rebuild():
    async def fake_exec(command: str, **_kwargs):
        if command == "test -f /srv/frameos/current/frameos":
            return 1
        return 0

    deployer = SimpleNamespace(exec_command=fake_exec)
    compile_plan = CompilePlan(
        mode="smart",
        rebuild_app=False,
        rebuild_scene_ids=(),
        reuse_scene_ids=(),
        rebuild_driver_ids=(),
        reuse_driver_ids=(),
        reason="Compile inputs unchanged",
    )
    manifest = CompileManifest(
        version=1,
        frameos_version="1.0.0",
        runtime_contract_hash="runtime",
        app_hash="app",
        scene_hashes={},
        driver_hashes={},
    )

    adjusted = await _adjust_compile_plan_for_missing_remote_artifacts(
        deployer,
        compile_plan,
        manifest,
    )

    assert adjusted.rebuild_app is True
    assert adjusted.rebuild_scene_ids == ()
    assert adjusted.reuse_scene_ids == ()
    assert adjusted.rebuild_driver_ids == ()
    assert adjusted.reuse_driver_ids == ()
    assert adjusted.reason == "Compile inputs unchanged; current FrameOS binary missing on device"
