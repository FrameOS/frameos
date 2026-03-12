import importlib.util
import sys
from pathlib import Path


def load_prepare_assets_module():
    repo_root = Path(__file__).resolve().parents[4]
    module_path = repo_root / "frameos" / "tools" / "prepare_assets.py"
    spec = importlib.util.spec_from_file_location("frameos_prepare_assets", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


prepare_assets = load_prepare_assets_module()


def write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def create_project_layout(tmp_path: Path) -> Path:
    repo_root = tmp_path / "repo"
    frameos_root = repo_root / "frameos"

    write(repo_root / "package.json", "{}\n")
    write(repo_root / "pnpm-workspace.yaml", "packages:\n  - frontend\n  - frameos/frontend\n")
    write(repo_root / "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    write(repo_root / "frontend" / "package.json", "{}\n")
    write(repo_root / "frontend" / "src" / "initKea.ts", "export function initKea() {}\n")
    write(repo_root / "frontend" / "schema" / "events.json", "{}\n")
    write(repo_root / "versions.json", "{\"web\":\"1.0.0\"}\n")

    write(frameos_root / "frontend" / "package.json", "{}\n")
    write(frameos_root / "frontend" / "build.mjs", "console.log('build')\n")
    write(frameos_root / "frontend" / "src" / "main.tsx", "export const main = 1\n")
    write(frameos_root / "frontend" / "src" / "index.html", "<html></html>\n")
    write(frameos_root / "src" / "apps" / "data" / "sample" / "config.json", "{\"name\":\"Sample\"}\n")
    write(frameos_root / "assets" / "compiled" / "web" / "control.html", "<html>control</html>\n")
    write(frameos_root / "assets" / "compiled" / "fonts" / "Ubuntu-Regular.ttf", b"font")

    return frameos_root


def test_prepare_assets_uses_manifest_to_skip_or_regenerate_work(tmp_path, monkeypatch):
    frameos_root = create_project_layout(tmp_path)
    build_calls: list[int] = []
    generate_calls: list[int] = []

    def fake_build_frontend(project_root: Path) -> None:
        build_calls.append(1)
        version = len(build_calls)
        write(project_root / "assets" / "compiled" / "frame_web" / "index.html", f"<html>{version}</html>\n")
        write(project_root / "assets" / "compiled" / "frame_web" / "static" / "main.js", f"console.log({version})\n")
        write(project_root / "assets" / "compiled" / "frame_web" / "static" / "main.css", f"body{{opacity:{version}}}\n")

    def fake_generate_asset_modules(project_root: Path) -> None:
        generate_calls.append(1)
        version = len(generate_calls)
        write(project_root / "src" / "assets" / "apps.nim", f"# apps {version}\n")
        write(project_root / "src" / "assets" / "web.nim", f"# web {version}\n")
        write(project_root / "src" / "assets" / "frame_web.nim", f"# frame web {version}\n")
        write(project_root / "src" / "assets" / "fonts.nim", f"# fonts {version}\n")

    monkeypatch.setattr(prepare_assets, "build_frontend", fake_build_frontend)
    monkeypatch.setattr(prepare_assets, "generate_asset_modules", fake_generate_asset_modules)

    first = prepare_assets.prepare_assets(frameos_root)
    assert first.rebuilt_frontend is True
    assert first.regenerated_modules is True
    assert len(build_calls) == 1
    assert len(generate_calls) == 1
    assert first.manifest_path.is_file()

    second = prepare_assets.prepare_assets(frameos_root)
    assert second.rebuilt_frontend is False
    assert second.regenerated_modules is False
    assert len(build_calls) == 1
    assert len(generate_calls) == 1

    write(frameos_root / "src" / "apps" / "data" / "sample" / "config.json", "{\"name\":\"Updated\"}\n")
    third = prepare_assets.prepare_assets(frameos_root)
    assert third.rebuilt_frontend is False
    assert third.regenerated_modules is True
    assert len(build_calls) == 1
    assert len(generate_calls) == 2

    write(frameos_root.parent / "frontend" / "src" / "initKea.ts", "export function initKea() { return 2 }\n")
    fourth = prepare_assets.prepare_assets(frameos_root)
    assert fourth.rebuilt_frontend is True
    assert fourth.regenerated_modules is True
    assert len(build_calls) == 2
    assert len(generate_calls) == 3


def test_ensure_frontend_dependencies_reinstalls_incomplete_existing_modules(tmp_path, monkeypatch):
    frameos_root = create_project_layout(tmp_path)
    frontend_root = frameos_root / "frontend"
    write(frontend_root / "node_modules" / "autoprefixer" / "package.json", "{}\n")

    commands: list[tuple[list[str], Path]] = []

    def fake_run_command(command: list[str], *, cwd: Path) -> None:
        commands.append((command, cwd))

    monkeypatch.setattr(prepare_assets, "frontend_dependencies_are_usable", lambda _frontend_root: False)
    monkeypatch.setattr(prepare_assets, "resolve_pnpm_command", lambda: ["pnpm"])
    monkeypatch.setattr(prepare_assets, "run_command", fake_run_command)

    prepare_assets.ensure_frontend_dependencies(frameos_root)

    assert commands == [(["pnpm", "install", "--frozen-lockfile"], frontend_root)]
    assert not (frontend_root / "node_modules").exists()
