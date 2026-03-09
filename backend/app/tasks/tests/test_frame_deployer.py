from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks._frame_deployer import FrameDeployer


def test_create_local_source_folder_copies_shared_frontend_sources(tmp_path: Path):
    repo_root = tmp_path / "repo"
    frameos_root = repo_root / "frameos"
    shared_frontend_src = repo_root / "frontend" / "src"
    shared_frontend_schema = repo_root / "frontend" / "schema"

    (frameos_root / "frontend" / "src").mkdir(parents=True)
    (frameos_root / "frontend" / "src" / "main.tsx").write_text("local frame frontend\n", encoding="utf-8")
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
    assert (copied_source_dir / "assets" / "compiled" / "web" / "control.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "frame_web" / "index.html").exists()
    assert (copied_source_dir / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf").exists()


@pytest.mark.asyncio
async def test_create_local_build_archive_reuses_precompiled_assets(tmp_path: Path, monkeypatch):
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

    assert Path(archive_path).exists()
    assert commands
    assert "FRAMEOS_USE_PRECOMPILED_ASSETS=1 nimble assets -y" in commands[0]
