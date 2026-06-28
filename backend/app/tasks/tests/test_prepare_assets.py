import importlib.util
import shutil
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
    write(repo_root / "frontend" / "scripts" / "generateRepoApps.mjs", "export {}\n")
    write(repo_root / "frontend" / "src" / "initKea.ts", "export function initKea() {}\n")
    write(repo_root / "frontend" / "public" / "img" / "logo-2" / "logo-white-colors.svg", "<svg />\n")
    write(repo_root / "frontend" / "schema" / "events.json", "{}\n")
    write(repo_root / "repo" / "apps" / "code" / "sample" / "config.json", "{\"name\":\"Sample\"}\n")
    write(repo_root / "repo" / "apps" / "code" / "sample" / "app.ts", "export function run() {}\n")
    write(repo_root / "repo" / "scenes" / "samples" / "repository.json", "{\"name\":\"Samples\"}\n")
    write(repo_root / "repo" / "scenes" / "samples" / "Sample" / "template.json", "{\"name\":\"Sample\"}\n")
    write(repo_root / "repo" / "scenes" / "samples" / "Sample" / "scenes.json", "[]\n")
    write(repo_root / "versions.json", "{\"web\":\"1.0.0\"}\n")

    write(frameos_root / "frontend" / "package.json", "{}\n")
    write(frameos_root / "frontend" / "build.mjs", "console.log('build')\n")
    write(frameos_root / "frontend" / "postcss.config.js", "export default {}\n")
    write(frameos_root / "frontend" / "src" / "main.tsx", "export const main = 1\n")
    write(frameos_root / "frontend" / "src" / "index.html", "<html></html>\n")
    write(frameos_root / "frontend" / "tailwind.config.js", "export default {}\n")
    write(frameos_root / "frontend" / "tsconfig.dev.json", "{}\n")
    write(frameos_root / "frontend" / "tsconfig.json", "{}\n")
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
        write(project_root / "src" / "assets" / "repo_scenes.nim", f"# repo scenes {version}\n")

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

    commands: list[tuple[list[str], Path, bool, dict[str, str] | None]] = []

    def fake_run_command(
        command: list[str],
        *,
        cwd: Path,
        quiet: bool = False,
        env: dict[str, str] | None = None,
    ) -> None:
        commands.append((command, cwd, quiet, env))

    monkeypatch.setattr(prepare_assets, "frontend_dependencies_are_usable", lambda _frontend_root: False)
    monkeypatch.setattr(prepare_assets, "resolve_pnpm_command", lambda: ["pnpm"])
    monkeypatch.setattr(prepare_assets, "run_command", fake_run_command)
    monkeypatch.setenv("DEBUG", "1")

    prepare_assets.ensure_frontend_dependencies(frameos_root)

    assert len(commands) == 1
    assert commands[0][:3] == (["pnpm", "install", "--frozen-lockfile"], frontend_root, True)
    assert commands[0][3] is not None
    assert "DEBUG" not in commands[0][3]
    assert not (frontend_root / "node_modules").exists()


def test_build_frontend_runs_quietly_without_debug_env(tmp_path, monkeypatch):
    frameos_root = create_project_layout(tmp_path)
    frontend_root = frameos_root / "frontend"
    commands: list[tuple[list[str], Path, bool, dict[str, str] | None]] = []

    def fake_run_command(
        command: list[str],
        *,
        cwd: Path,
        quiet: bool = False,
        env: dict[str, str] | None = None,
    ) -> None:
        commands.append((command, cwd, quiet, env))
        write(frameos_root / "assets" / "compiled" / "frame_web" / "index.html", "<html></html>\n")
        write(frameos_root / "assets" / "compiled" / "frame_web" / "static" / "main.js", "console.log(1)\n")
        write(frameos_root / "assets" / "compiled" / "frame_web" / "static" / "main.css", "body{}\n")

    monkeypatch.setattr(prepare_assets, "ensure_frontend_dependencies", lambda _project_root: None)
    monkeypatch.setattr(prepare_assets, "resolve_pnpm_command", lambda: ["pnpm"])
    monkeypatch.setattr(prepare_assets, "run_command", fake_run_command)
    monkeypatch.setenv("DEBUG", "1")

    prepare_assets.build_frontend(frameos_root)

    assert len(commands) == 1
    assert commands[0][:3] == (["pnpm", "run", "build"], frontend_root, True)
    assert commands[0][3] is not None
    assert "DEBUG" not in commands[0][3]


def test_hash_frontend_inputs_ignores_node_modules(tmp_path):
    frameos_root = create_project_layout(tmp_path)
    frontend_root = frameos_root / "frontend"

    before = prepare_assets.hash_frontend_inputs(frameos_root)
    write(frontend_root / "node_modules" / "autoprefixer" / "package.json", "{}\n")
    after = prepare_assets.hash_frontend_inputs(frameos_root)

    assert after == before


def test_hash_frontend_inputs_tracks_repo_app_templates(tmp_path):
    frameos_root = create_project_layout(tmp_path)

    before = prepare_assets.hash_frontend_inputs(frameos_root)
    write(frameos_root.parent / "repo" / "apps" / "code" / "sample" / "config.json", "{\"name\":\"Updated\"}\n")
    after = prepare_assets.hash_frontend_inputs(frameos_root)

    assert after != before


def test_hash_module_inputs_tracks_repo_scene_templates(tmp_path):
    frameos_root = create_project_layout(tmp_path)

    before = prepare_assets.hash_module_inputs(frameos_root)
    write(
        frameos_root.parent / "repo" / "scenes" / "samples" / "Sample" / "template.json",
        "{\"name\":\"Updated\"}\n",
    )
    after = prepare_assets.hash_module_inputs(frameos_root)

    assert after != before


def test_hash_frontend_inputs_tracks_shared_public_assets(tmp_path):
    frameos_root = create_project_layout(tmp_path)

    before = prepare_assets.hash_frontend_inputs(frameos_root)
    write(
        frameos_root.parent / "frontend" / "public" / "img" / "logo-2" / "logo-white-colors.svg",
        "<svg><title>Updated</title></svg>\n",
    )
    after = prepare_assets.hash_frontend_inputs(frameos_root)

    assert after != before


def test_missing_frontend_inputs_require_generator_but_not_repo_apps(tmp_path):
    frameos_root = create_project_layout(tmp_path)

    shutil.rmtree(frameos_root.parent / "repo" / "apps")
    assert Path("../repo/apps/code") not in prepare_assets.missing_frontend_inputs(frameos_root)

    (frameos_root.parent / "frontend" / "scripts" / "generateRepoApps.mjs").unlink()

    assert Path("../frontend/scripts/generateRepoApps.mjs") in prepare_assets.missing_frontend_inputs(frameos_root)

    shutil.rmtree(frameos_root.parent / "frontend" / "public")

    assert Path("../frontend/public") in prepare_assets.missing_frontend_inputs(frameos_root)


def test_prepare_assets_uses_packaged_frontend_when_shared_sources_are_missing(tmp_path, monkeypatch):
    frameos_root = create_project_layout(tmp_path)
    frontend_hash = "frontend-hash"
    modules_hash = "modules-hash"
    write(
        frameos_root / "assets" / "compiled" / ".manifest.json",
        (
            "{\n"
            '  "frontend_hash": "frontend-hash",\n'
            '  "modules_hash": "modules-hash",\n'
            '  "version": 1\n'
            "}\n"
        ),
    )
    write(frameos_root / "assets" / "compiled" / "frame_web" / "index.html", "<html></html>\n")
    write(frameos_root / "assets" / "compiled" / "frame_web" / "static" / "main.js", "console.log(1)\n")
    write(frameos_root / "assets" / "compiled" / "frame_web" / "static" / "main.css", "body{}\n")
    write(frameos_root / "src" / "assets" / "apps.nim", "# apps\n")
    write(frameos_root / "src" / "assets" / "web.nim", "# web\n")
    write(frameos_root / "src" / "assets" / "frame_web.nim", "# frame web\n")
    write(frameos_root / "src" / "assets" / "fonts.nim", "# fonts\n")
    write(frameos_root / "src" / "assets" / "repo_scenes.nim", "# repo scenes\n")
    shutil.rmtree(frameos_root.parent / "frontend" / "src")

    build_calls: list[int] = []

    def fake_build_frontend(_project_root: Path) -> None:
        build_calls.append(1)

    monkeypatch.setattr(prepare_assets, "build_frontend", fake_build_frontend)
    monkeypatch.setattr(prepare_assets, "hash_module_inputs", lambda _project_root: modules_hash)

    result = prepare_assets.prepare_assets(frameos_root)

    assert result.rebuilt_frontend is False
    assert result.regenerated_modules is False
    assert build_calls == []
    manifest = prepare_assets.load_manifest(frameos_root)
    assert manifest is not None
    assert manifest.frontend_hash == frontend_hash
    assert manifest.modules_hash == modules_hash
