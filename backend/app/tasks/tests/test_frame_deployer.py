from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.drivers.drivers import DRIVERS
from app.codegen.drivers_nim import write_driver_library_nim
from app.tasks import _frame_deployer as frame_deployer_module
from app.tasks._frame_deployer import FrameDeployer


def test_create_local_source_folder_copies_shared_frontend_sources(tmp_path: Path):
    repo_root = tmp_path / "repo"
    frameos_root = repo_root / "frameos"
    shared_frontend_src = repo_root / "frontend" / "src"
    shared_frontend_schema = repo_root / "frontend" / "schema"

    (frameos_root / "frontend" / "src").mkdir(parents=True)
    (frameos_root / "frontend" / "src" / "main.tsx").write_text("local frame frontend\n", encoding="utf-8")
    (frameos_root / "frontend" / "node_modules" / "autoprefixer").mkdir(parents=True)
    (frameos_root / "frontend" / "node_modules" / "autoprefixer" / "package.json").write_text("{}", encoding="utf-8")
    (frameos_root / ".flox" / "run").mkdir(parents=True)
    (frameos_root / ".flox" / "run" / "env").write_text("cached env\n", encoding="utf-8")
    (frameos_root / ".git" / "objects").mkdir(parents=True)
    (frameos_root / ".git" / "objects" / "pack").write_text("git data\n", encoding="utf-8")
    (frameos_root / ".pnpm-store" / "v10").mkdir(parents=True)
    (frameos_root / ".pnpm-store" / "v10" / "store.json").write_text("{}", encoding="utf-8")
    (frameos_root / ".venv" / "bin").mkdir(parents=True)
    (frameos_root / ".venv" / "bin" / "python").write_text("python\n", encoding="utf-8")
    (frameos_root / "nimcache" / "local-test").mkdir(parents=True)
    (frameos_root / "nimcache" / "local-test" / "frameos.o").write_bytes(b"object")
    (frameos_root / "build").mkdir()
    (frameos_root / "build" / "frameos").write_bytes(b"binary")
    (frameos_root / "src" / "frameos" / "tests").mkdir(parents=True)
    (frameos_root / "src" / "frameos" / "tests" / "test_runner_loop").write_bytes(b"binary")
    (frameos_root / "src" / "frameos" / "tests" / "test_runner_loop.nim").write_text("discard\n", encoding="utf-8")
    (frameos_root / "src" / "frameos" / "runtime.nim").write_text("discard\n", encoding="utf-8")
    shared_frontend_src.mkdir(parents=True)
    (shared_frontend_src / "initKea.ts").write_text("export function initKea() {}\n", encoding="utf-8")
    shared_frontend_schema.mkdir(parents=True)
    (shared_frontend_schema / "events.json").write_text("{}\n", encoding="utf-8")
    (repo_root / "frontend" / "scripts").mkdir(parents=True)
    (repo_root / "frontend" / "scripts" / "generateRepoApps.mjs").write_text("export {}\n", encoding="utf-8")
    (repo_root / "repo" / "apps" / "code" / "sample").mkdir(parents=True)
    (repo_root / "repo" / "apps" / "code" / "sample" / "config.json").write_text("{\"name\":\"Sample\"}\n", encoding="utf-8")
    (repo_root / "repo" / "apps" / "code" / "sample" / "app.ts").write_text("export function run() {}\n", encoding="utf-8")
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
    assert (tmp_path / "build" / "frontend" / "scripts" / "generateRepoApps.mjs").exists()
    assert (tmp_path / "build" / "frontend" / "package.json").exists()
    assert (tmp_path / "build" / "repo" / "apps" / "code" / "sample" / "config.json").exists()
    assert (tmp_path / "build" / "repo" / "apps" / "code" / "sample" / "app.ts").exists()
    assert (tmp_path / "build" / "versions.json").exists()
    assert not (copied_source_dir / ".flox").exists()
    assert not (copied_source_dir / ".git").exists()
    assert not (copied_source_dir / ".pnpm-store").exists()
    assert not (copied_source_dir / ".venv").exists()
    assert not (copied_source_dir / "frontend" / "node_modules").exists()
    assert not (copied_source_dir / "nimcache").exists()
    assert not (copied_source_dir / "build").exists()
    assert not (copied_source_dir / "src" / "frameos" / "tests").exists()
    assert (copied_source_dir / "src" / "frameos" / "runtime.nim").exists()
    assert (copied_source_dir / "assets" / "compiled" / "web" / "control.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "frame_web" / "index.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf").exists()


def test_create_local_source_folder_default_source_root_ignores_cwd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    repo_root = tmp_path / "repo"
    frameos_root = repo_root / "frameos"
    wrong_root = tmp_path / "frameos"
    frameos_root.mkdir(parents=True)
    wrong_root.mkdir()
    (frameos_root / "frameos.nimble").write_text("# real runtime\n", encoding="utf-8")
    (wrong_root / "wrong.txt").write_text("wrong cwd-relative runtime\n", encoding="utf-8")

    monkeypatch.setattr(frame_deployer_module, "DEFAULT_FRAMEOS_SOURCE_ROOT", frameos_root)
    monkeypatch.chdir(repo_root)

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        nim_path="/usr/bin/nim",
        temp_dir=str(tmp_path / "work"),
    )

    copied_source_dir = Path(deployer.create_local_source_folder(str(tmp_path / "build")))

    assert (copied_source_dir / "frameos.nimble").exists()
    assert not (copied_source_dir / "wrong.txt").exists()


def test_copy_waveshare_build_files_stages_lgpio_header(tmp_path: Path):
    source_dir = tmp_path / "frameos"
    destination_dir = tmp_path / "build"
    waveshare_dir = source_dir / "src" / "drivers" / "waveshare" / "ePaper"
    lib_dir = source_dir / "src" / "lib"
    waveshare_dir.mkdir(parents=True)
    lib_dir.mkdir(parents=True)
    destination_dir.mkdir()

    for file_name in ("Debug.h", "DEV_Config.c", "DEV_Config.h", "EPD_7in3e.nim"):
        (waveshare_dir / file_name).write_text(f"{file_name}\n", encoding="utf-8")
    (lib_dir / "lgpio.h").write_text("native lgpio header\n", encoding="utf-8")

    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        nim_path="/usr/bin/nim",
        temp_dir=str(tmp_path / "work"),
    )
    waveshare = replace(DRIVERS["waveshare"], variant="EPD_7in3e")

    deployer._copy_waveshare_driver_build_files(str(source_dir), str(destination_dir), waveshare)

    assert (destination_dir / "DEV_Config.h").read_text(encoding="utf-8") == "DEV_Config.h\n"
    assert (destination_dir / "lgpio.h").read_text(encoding="utf-8") == "native lgpio header\n"


async def _run_create_local_build_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, list[str]]:
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (tmp_path / "versions.json").write_text("{\"frameos\":\"1.2.3+abc\"}\n", encoding="utf-8")
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


def test_demangle_nimcache_name() -> None:
    assert (
        FrameDeployer._demangle_nimcache_name("@zqeviref@fjnirfuner@frCncre@fQRI_Pbasvt.p")
        == "drivers/waveshare/ePaper/DEV_Config.c"
    )


def test_copy_external_compile_sources_recovers_compile_pragma_files(tmp_path: Path) -> None:
    # nim --genScript emits {.compile.} C files as bare basenames and never
    # copies them into the nimcache; the deployer must recover them (and their
    # local headers) from the mangled object path on the compile line.
    source_dir = tmp_path / "frameos"
    epaper = source_dir / "src" / "drivers" / "waveshare" / "ePaper"
    epaper.mkdir(parents=True)
    lib = source_dir / "src" / "lib"
    lib.mkdir(parents=True)
    (epaper / "DEV_Config.c").write_text('#include "DEV_Config.h"\n', encoding="utf-8")
    (epaper / "DEV_Config.h").write_text('#include "Debug.h"\n#include "lgpio.h"\n', encoding="utf-8")
    (epaper / "Debug.h").write_text("/* debug */\n", encoding="utf-8")
    (lib / "lgpio.h").write_text("/* lgpio */\n", encoding="utf-8")

    build_dir = tmp_path / "build"
    build_dir.mkdir()
    script = build_dir / "compile_frameos.sh"
    script.write_text(
        "gcc -c -w -I. -Isrc/lib -I/abs/nim/lib "
        "-o @zqeviref@fjnirfuner@frCncre@fQRI_Pbasvt.p.o DEV_Config.c\n"
        "gcc -c -w -I. -o @zsbb.nim.c.o @zsbb.nim.c\n",
        encoding="utf-8",
    )

    FrameDeployer._copy_external_compile_sources(str(build_dir), str(script), str(source_dir))

    for name in ("DEV_Config.c", "DEV_Config.h", "Debug.h", "lgpio.h"):
        assert (build_dir / name).exists(), f"{name} missing from build dir"


@pytest.mark.asyncio
async def test_create_local_build_archive_runs_assets_task_without_env_switch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _archive_path, commands = await _run_create_local_build_archive(tmp_path, monkeypatch)

    assert commands
    assert "cd " in commands[0]
    assert "nimble assets -y && nimble setup &&" in commands[0]
    assert "-d:malloc" in commands[0]
    assert "--define:frameosVersion:1.2.3+abc" in commands[0]


@pytest.mark.asyncio
async def test_create_local_build_archive_generates_shared_driver_makefiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "LIBS =\nCFLAGS =\nall: $(EXECUTABLE)\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")
    commands: list[str] = []

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **_kwargs):
        commands.append(cmd)
        nimcache = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
        cache_dir = Path(nimcache)
        cache_dir.mkdir(parents=True, exist_ok=True)
        if "src/frameos.nim" in cmd:
            (cache_dir / "compile_frameos.sh").write_text(
                "cc -c frameos.c -o frameos.o -Wall\n"
                "cc frameos.o -o frameos -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        else:
            (cache_dir / "compile_httpUpload.sh").write_text(
                "cc -c driver.c -o driver.o -fPIC -Wall\n"
                "cc driver.o -shared -o httpUpload.so -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {"httpUpload": DRIVERS["httpUpload"]})

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

    await deployer.create_local_build_archive(str(build_dir), str(source_dir), "arm64", compilation_mode="shared")

    assert len(commands) == 2
    assert "-d:malloc" in commands[0]
    assert "src/drivers/shared/httpUpload.nim" in commands[1]
    assert "-d:malloc" in commands[1]
    assert "--define:frameosDriverLibrary" in commands[1]
    assert "--opt:size" in commands[1]
    assert "--stackTrace:off" in commands[1]
    assert "--lineTrace:off" in commands[1]
    assert "--passL:-Wl,--gc-sections" in commands[1]
    makefile_text = (build_dir / "Makefile").read_text(encoding="utf-8")
    assert "LIBRARY_DIRS = drivers/httpUpload" in makefile_text
    assert "DRIVER_DIRS = drivers/httpUpload" in makefile_text
    assert "shared-libraries: $(LIBRARY_DIRS)" in makefile_text
    assert "driver-libraries: $(DRIVER_DIRS)" in makefile_text
    assert "+$(MAKE) -C $@" in makefile_text
    assert "for dir in $(DRIVER_DIRS)" not in makefile_text
    driver_makefile = build_dir / "drivers" / "httpUpload" / "Makefile"
    driver_makefile_text = driver_makefile.read_text(encoding="utf-8")
    assert "LIBRARY = httpUpload.so" in driver_makefile_text
    assert "STRIP ?= strip" in driver_makefile_text
    assert "🟣 Compiling driver $(LIBRARY)" in driver_makefile_text
    assert "🟣 Linking $(LIBRARY)" in driver_makefile_text
    assert "sed 's/@f/" in driver_makefile_text
    assert "tr 'A-Za-z' 'N-ZA-Mn-za-m'" in driver_makefile_text
    assert "--strip-unneeded $(LIBRARY)" in driver_makefile_text
    assert "-ffunction-sections" in driver_makefile_text
    assert "-fdata-sections" in driver_makefile_text
    assert "-fno-asynchronous-unwind-tables" in driver_makefile_text
    assert "-fno-unwind-tables" in driver_makefile_text
    assert "-Wl,--gc-sections" in driver_makefile_text


@pytest.mark.asyncio
async def test_create_local_build_archive_generates_shared_scene_makefiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "LIBS =\nCFLAGS =\nall: $(EXECUTABLE)\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")
    commands: list[str] = []

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **_kwargs):
        commands.append(cmd)
        nimcache = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
        cache_dir = Path(nimcache)
        cache_dir.mkdir(parents=True, exist_ok=True)
        if "src/frameos.nim" in cmd:
            (cache_dir / "compile_frameos.sh").write_text(
                "cc -c frameos.c -o frameos.o -Wall\n"
                "cc frameos.o -o frameos -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        else:
            (cache_dir / "compile_scene_myscene.sh").write_text(
                "cc -c scene.c -o scene.o -fPIC -Wall\n"
                "cc scene.o -shared -o scene_myscene.so -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    frame = SimpleNamespace(
        id=1,
        debug=False,
        scenes=[{"id": "my-scene", "name": "My Scene", "settings": {"execution": "compiled"}}],
    )
    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=frame,
        nim_path="/usr/bin/nim",
        temp_dir=str(temp_dir),
    )
    deployer.log = fake_log  # type: ignore[method-assign]
    build_dir = temp_dir / f"build_{deployer.build_id}"
    build_dir.mkdir()

    await deployer.create_local_build_archive(str(build_dir), str(source_dir), "arm64", compilation_mode="shared")

    assert len(commands) == 2
    assert "-d:malloc" in commands[0]
    assert "src/scenes/shared/scene_myscene.nim" in commands[1]
    assert "-d:malloc" in commands[1]
    assert "--define:frameosSharedLibrary" in commands[1]
    scene_makefile = build_dir / "scenes" / "myscene" / "Makefile"
    scene_makefile_text = scene_makefile.read_text(encoding="utf-8")
    assert "LIBRARY = scene_myscene.so" in scene_makefile_text
    assert "Compiling scene $(LIBRARY)" in scene_makefile_text
    makefile_text = (build_dir / "Makefile").read_text(encoding="utf-8")
    assert "LIBRARY_DIRS = scenes/myscene" in makefile_text
    assert "SCENE_DIRS = scenes/myscene" in makefile_text
    assert "scene-libraries: $(SCENE_DIRS)" in makefile_text


@pytest.mark.asyncio
async def test_create_local_build_archive_generates_shared_scene_bundle_makefile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_dir = tmp_path / "frameos"
    temp_dir = tmp_path / "temp"
    source_dir.mkdir()
    temp_dir.mkdir()
    (source_dir / "tools").mkdir()
    (source_dir / "tools" / "nimc.Makefile").write_text(
        "LIBS =\nCFLAGS =\nall: $(EXECUTABLE)\n",
        encoding="utf-8",
    )

    nimbase = tmp_path / "nimbase.h"
    nimbase.write_text("/* nimbase */\n", encoding="utf-8")
    commands: list[str] = []

    async def fake_exec_local_command(_db, _redis, _frame, cmd, **_kwargs):
        commands.append(cmd)
        nimcache = cmd.split("--nimcache:", 1)[1].split(" ", 1)[0]
        cache_dir = Path(nimcache)
        cache_dir.mkdir(parents=True, exist_ok=True)
        if "src/frameos.nim" in cmd:
            (cache_dir / "compile_frameos.sh").write_text(
                "cc -c frameos.c -o frameos.o -Wall\n"
                "cc frameos.o -o frameos -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        else:
            (cache_dir / "compile_scene_bundle.sh").write_text(
                "cc -c scene.c -o scene.o -fPIC -Wall\n"
                "cc scene.o -shared -o scenes.so -pthread -lm -ldl\n",
                encoding="utf-8",
            )
        return 0, "", ""

    async def fake_log(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.tasks._frame_deployer.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr("app.tasks._frame_deployer.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr("app.tasks._frame_deployer.drivers_for_frame", lambda _frame: {})

    frame = SimpleNamespace(
        id=1,
        debug=False,
        scenes=[{"id": "my-scene", "name": "My Scene", "settings": {"execution": "compiled"}}],
    )
    deployer = FrameDeployer(
        db=None,
        redis=None,
        frame=frame,
        nim_path="/usr/bin/nim",
        temp_dir=str(temp_dir),
    )
    deployer.log = fake_log  # type: ignore[method-assign]
    build_dir = temp_dir / f"build_{deployer.build_id}"
    build_dir.mkdir()

    await deployer.create_local_build_archive(str(build_dir), str(source_dir), "arm64", compilation_mode="shared-scenes")

    assert len(commands) == 2
    assert "-d:malloc" in commands[0]
    assert "src/scenes/scenes_bundle.nim" in commands[1]
    assert "-d:malloc" in commands[1]
    assert "--define:frameosSharedLibrary" in commands[1]
    scene_makefile = build_dir / "scenes" / "Makefile"
    scene_makefile_text = scene_makefile.read_text(encoding="utf-8")
    assert "LIBRARY = scenes.so" in scene_makefile_text
    assert "Compiling scene $(LIBRARY)" in scene_makefile_text
    makefile_text = (build_dir / "Makefile").read_text(encoding="utf-8")
    assert "LIBRARY_DIRS = scenes" in makefile_text
    assert "SCENE_DIRS = scenes" in makefile_text
    assert "scene-libraries: $(SCENE_DIRS)" in makefile_text


def test_evdev_shared_driver_wrapper_avoids_image_runtime_imports():
    source = write_driver_library_nim(DRIVERS["evdev"])

    assert "import pixie" not in source
    assert "import frameos/types" not in source
    assert "proc frameos_driver_init*(driverContextPtr: pointer" in source
