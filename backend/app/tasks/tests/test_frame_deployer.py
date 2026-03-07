from pathlib import Path
from types import SimpleNamespace

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
