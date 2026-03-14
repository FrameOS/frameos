from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks._frame_deployer import FrameDeployer


def test_parse_compile_script_preserves_shared_flag_for_full_output_path(tmp_path: Path):
    script_path = tmp_path / "compile_plugin_demo.sh"
    script_path.write_text(
        "cc -c foo.c -o foo.o -fPIC -Wall\n"
        "cc foo.o -shared -o /tmp/build/demo.so quickjs/libquickjs.a -ldl\n",
        encoding="utf-8",
    )

    compiler_flags, linker_flags = FrameDeployer._parse_compile_script(
        str(script_path),
        output_name="demo.so",
    )

    assert "-fPIC" in compiler_flags
    assert "-shared" in linker_flags
    assert "quickjs/libquickjs.a" in linker_flags
    assert "-ldl" in linker_flags


def test_create_local_source_folder_copies_shared_frontend_sources(tmp_path: Path):
    repo_root = tmp_path / "repo"
    frameos_root = repo_root / "frameos"
    shared_frontend_src = repo_root / "frontend" / "src"
    shared_frontend_schema = repo_root / "frontend" / "schema"

    (frameos_root / "frontend" / "src").mkdir(parents=True)
    (frameos_root / "frontend" / "src" / "main.tsx").write_text("local frame frontend\n", encoding="utf-8")
    (frameos_root / "frontend" / "node_modules" / "autoprefixer").mkdir(parents=True)
    (frameos_root / "frontend" / "node_modules" / "autoprefixer" / "package.json").write_text("{}", encoding="utf-8")
    shared_frontend_src.mkdir(parents=True)
    (shared_frontend_src / "initKea.ts").write_text("export function initKea() {}\n", encoding="utf-8")
    shared_frontend_schema.mkdir(parents=True)
    (shared_frontend_schema / "events.json").write_text("{}\n", encoding="utf-8")
    (repo_root / "package.json").write_text("{}\n", encoding="utf-8")
    (repo_root / "pnpm-workspace.yaml").write_text("packages:\n  - frontend\n  - frameos/frontend\n", encoding="utf-8")
    (repo_root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    (repo_root / "frontend" / "package.json").write_text("{}\n", encoding="utf-8")
    (repo_root / "versions.json").write_text("{\"web\":\"1.0.0\"}\n", encoding="utf-8")
    (frameos_root / "assets" / "compiled" / "web").mkdir(parents=True)
    (frameos_root / "assets" / "compiled" / "frame_web" / "static").mkdir(parents=True)
    (frameos_root / "assets" / "compiled" / "fonts").mkdir(parents=True)
    (frameos_root / "assets" / "compiled" / "web" / "control.html").write_text("<html></html>\n", encoding="utf-8")
    (frameos_root / "assets" / "compiled" / "frame_web" / "index.html").write_text("<html></html>\n", encoding="utf-8")
    (frameos_root / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf").write_bytes(b"font")

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        nim_path="/usr/bin/nim",
        temp_dir=str(tmp_path / "work"),
    )

    copied_source_dir = Path(deployer.create_local_source_folder(str(tmp_path / "build"), str(frameos_root)))

    assert (copied_source_dir / "frontend" / "src" / "main.tsx").exists()
    assert (tmp_path / "build" / "package.json").exists()
    assert (tmp_path / "build" / "pnpm-workspace.yaml").exists()
    assert (tmp_path / "build" / "pnpm-lock.yaml").exists()
    assert (tmp_path / "build" / "frontend" / "src" / "initKea.ts").exists()
    assert (tmp_path / "build" / "frontend" / "schema" / "events.json").exists()
    assert (tmp_path / "build" / "frontend" / "package.json").exists()
    assert (tmp_path / "build" / "versions.json").exists()
    assert not (copied_source_dir / "frontend" / "node_modules").exists()
    assert (copied_source_dir / "assets" / "compiled" / "web" / "control.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "frame_web" / "index.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf").exists()


@pytest.mark.asyncio
async def test_make_local_modifications_writes_scene_plugin_wrappers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    (source_dir / "src" / "apps").mkdir(parents=True)
    (source_dir / "src" / "drivers").mkdir(parents=True)
    (source_dir / "src" / "scenes").mkdir(parents=True)

    monkeypatch.setattr("app.tasks._frame_deployer.get_apps_from_scenes", lambda _scenes: {})
    monkeypatch.setattr("app.tasks._frame_deployer.write_apps_nim", lambda _root: "apps\n")
    monkeypatch.setattr("app.tasks._frame_deployer.write_scene_nim", lambda _frame, _scene: "scene\n")
    monkeypatch.setattr("app.tasks._frame_deployer.write_scene_plugin_nim", lambda _scene, is_default=False: f"plugin default={is_default}\n")
    monkeypatch.setattr("app.tasks._frame_deployer.write_scenes_nim", lambda _frame: "registry\n")
    monkeypatch.setattr("app.tasks._frame_deployer.write_drivers_nim", lambda _drivers: "drivers\n")
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    frame = SimpleNamespace(
        id=1,
        scenes=[
            {"id": "hello/world", "name": "Hello", "default": True, "settings": {"execution": "compiled"}},
            {"id": "interpreted", "settings": {"execution": "interpreted"}},
        ],
    )
    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=frame,
        nim_path="/usr/bin/nim",
        temp_dir=str(tmp_path / "work"),
    )
    deployer.log = lambda *_args, **_kwargs: None  # type: ignore[method-assign]

    await deployer.make_local_modifications(str(source_dir))

    assert (source_dir / "src" / "scenes" / "scene_hello_world.nim").read_text(encoding="utf-8") == "scene\n"
    assert (source_dir / "src" / "scenes" / "plugin_hello_world.nim").read_text(encoding="utf-8") == "plugin default=True\n"
    assert not (source_dir / "src" / "scenes" / "scene_interpreted.nim").exists()
    assert (source_dir / "src" / "scenes" / "scenes.nim").read_text(encoding="utf-8") == "registry\n"


async def _run_create_local_build_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, list[str]]:
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "LIBS =\nCFLAGS =\nall:\n\t@true\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")
    commands: list[str] = []

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **_kwargs):
        commands.append(cmd)
        if "src/frameos.nim" in cmd:
            (build_dir / "compile_frameos.sh").write_text(
                "cc -c foo.c -o foo.o -Wall\n"
                "cc foo.o -o frameos -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1, debug=False),
        nim_path="/usr/bin/nim",
        temp_dir=str(temp_dir),
    )
    deployer.log = fake_log  # type: ignore[method-assign]
    build_dir = temp_dir / f"build_{deployer.build_id}"
    build_dir.mkdir()

    archive_path = await deployer.create_local_build_archive(str(build_dir), str(source_dir), "arm64")

    return archive_path, commands


@pytest.mark.asyncio
async def test_create_local_build_archive_runs_assets_task_without_env_switch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _archive_path, commands = await _run_create_local_build_archive(tmp_path, monkeypatch)

    assert len(commands) == 2
    assert "cd " in commands[0]
    assert commands[0].endswith("nimble assets -y && nimble setup")
    assert "src/frameos.nim" in commands[1]


@pytest.mark.asyncio
async def test_create_local_build_archive_emits_compiled_scene_targets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "src" / "scenes").mkdir(parents=True)
    (source_dir / "src" / "scenes" / "plugin_demo.nim").write_text("discard\n", encoding="utf-8")
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "EXECUTABLE = frameos\nall: $(EXECUTABLE)\nLIBS =\nCFLAGS =\nclean:\n\trm -f *.o $(EXECUTABLE)\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **_kwargs):
        if cmd.endswith("nimble assets -y && nimble setup"):
            return 0, "", ""
        if "src/frameos.nim" in cmd:
            build_dir_arg = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
            Path(build_dir_arg, "compile_frameos.sh").write_text(
                "cc -c foo.c -o foo.o -Wall\n"
                "cc foo.o -o frameos -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        else:
            build_dir_arg = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
            out_arg = cmd.split("--out:", 1)[1].split(" ", 1)[0]
            Path(build_dir_arg, "compile_plugin_demo.sh").write_text(
                "cc -c foo.c -o foo.o -fPIC -Wall\n"
                f"cc foo.o -shared -o {out_arg} quickjs/libquickjs.a -ldl\n",
                encoding="utf-8",
            )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1, debug=False),
        nim_path="/usr/bin/nim",
        temp_dir=str(temp_dir),
    )
    deployer.log = fake_log  # type: ignore[method-assign]
    build_dir = temp_dir / f"build_{deployer.build_id}"
    build_dir.mkdir()

    await deployer.create_local_build_archive(str(build_dir), str(source_dir), "arm64")

    root_makefile = (build_dir / "Makefile").read_text(encoding="utf-8")
    scene_makefile = (build_dir / "scene_builds" / "demo" / "Makefile").read_text(encoding="utf-8")

    assert "compiled-scenes" in root_makefile
    assert "SCENE_BUILD_DIRS = scene_builds/demo" in root_makefile
    assert "all: $(EXECUTABLE)\n\t@$(MAKE) --no-print-directory compiled-scenes\n" in root_makefile
    assert "$(MAKE) --no-print-directory -C $$dir" in root_makefile
    assert "EXECUTABLE = ../../scenes/demo.so" in scene_makefile
    assert "-shared" in scene_makefile
    assert "quickjs/libquickjs.a" not in scene_makefile


@pytest.mark.asyncio
async def test_create_local_build_archive_can_prepare_scene_subset_without_frameos_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "src" / "scenes").mkdir(parents=True)
    (source_dir / "src" / "scenes" / "plugin_demo.nim").write_text("discard\n", encoding="utf-8")
    (source_dir / "src" / "scenes" / "plugin_other.nim").write_text("discard\n", encoding="utf-8")
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "EXECUTABLE = frameos\nall: $(EXECUTABLE)\nLIBS =\nCFLAGS =\nclean:\n\trm -f *.o $(EXECUTABLE)\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")
    commands: list[tuple[str, dict]] = []

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **kwargs):
        commands.append((cmd, kwargs))
        if cmd.endswith("nimble assets -y && nimble setup"):
            return 0, "", ""
        build_dir_arg = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
        out_arg = cmd.split("--out:", 1)[1].split(" ", 1)[0]
        Path(build_dir_arg, f"compile_{Path(out_arg).stem}.sh").write_text(
            "cc -c foo.c -o foo.o -fPIC -Wall\n"
            f"cc foo.o -shared -o {out_arg} quickjs/libquickjs.a -ldl\n",
            encoding="utf-8",
        )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1, debug=False),
        nim_path="/usr/bin/nim",
        temp_dir=str(temp_dir),
    )
    deployer.log = fake_log  # type: ignore[method-assign]
    build_dir = temp_dir / f"build_{deployer.build_id}"
    build_dir.mkdir()

    await deployer.create_local_build_archive(
        str(build_dir),
        str(source_dir),
        "arm64",
        build_binary=False,
        build_scene_ids=["demo"],
        build_all_scenes=False,
    )

    command_text = "\n".join(command for command, _kwargs in commands)
    assert "src/frameos.nim" not in command_text
    assert "plugin_demo.nim" in command_text
    assert "plugin_other.nim" not in command_text
    assert not (build_dir / "Makefile").exists()
    assert (build_dir / "scene_builds" / "demo" / "Makefile").exists()
    assert all(kwargs["log_command"] is False for _command, kwargs in commands)
    assert all(kwargs["log_output"] is False for _command, kwargs in commands)
