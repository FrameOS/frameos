#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


MANIFEST_VERSION = 1
MANIFEST_PATH = Path("assets/compiled/.manifest.json")

FRONTEND_OUTPUTS = (
    Path("assets/compiled/frame_web/index.html"),
    Path("assets/compiled/frame_web/static/main.js"),
    Path("assets/compiled/frame_web/static/main.css"),
)

MODULE_OUTPUTS = (
    Path("src/assets/apps.nim"),
    Path("src/assets/web.nim"),
    Path("src/assets/frame_web.nim"),
    Path("src/assets/fonts.nim"),
)

MODULE_SOURCE_FILES = (
    Path("assets/compiled/web/control.html"),
    Path("assets/compiled/fonts/Ubuntu-Regular.ttf"),
    Path("tools/generate_apps_asset_nim.py"),
    Path("tools/generate_compressed_asset_nim.py"),
    Path("tools/prepare_assets.py"),
)

REPO_ROOT_FILES = (
    Path("package.json"),
    Path("pnpm-workspace.yaml"),
    Path("pnpm-lock.yaml"),
    Path("frontend/package.json"),
    Path("versions.json"),
)


@dataclass(frozen=True)
class AssetsManifest:
    version: int
    frontend_hash: str
    modules_hash: str


@dataclass(frozen=True)
class AssetPreparationResult:
    rebuilt_frontend: bool
    regenerated_modules: bool
    manifest_path: Path


def run_command(command: list[str], *, cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def iter_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    if path.is_file():
        return [path]
    return sorted(candidate for candidate in path.rglob("*") if candidate.is_file())


def hash_inputs(root: Path, entries: list[Path]) -> str:
    digest = hashlib.sha256()
    seen: set[Path] = set()

    for entry in entries:
        abs_entry = (root / entry).resolve()
        rel_entry = entry.as_posix()
        if not abs_entry.exists():
            digest.update(f"missing:{rel_entry}\n".encode("utf-8"))
            continue

        if abs_entry.is_file():
            files_with_labels = [(abs_entry, rel_entry)]
        else:
            files = iter_files(abs_entry)
            files_with_labels = [
                (
                    file_path,
                    f"{rel_entry}/{file_path.relative_to(abs_entry).as_posix()}",
                )
                for file_path in files
            ]

        if not files_with_labels:
            digest.update(f"empty:{rel_entry}\n".encode("utf-8"))
            continue

        for file_path, rel_path in files_with_labels:
            if file_path in seen:
                continue
            seen.add(file_path)
            digest.update(f"path:{rel_path}\n".encode("utf-8"))
            digest.update(file_path.read_bytes())
            digest.update(b"\n")

    return digest.hexdigest()


def hash_frontend_inputs(project_root: Path) -> str:
    entries = [
        Path("frontend"),
        Path("../frontend/src"),
        Path("../frontend/schema"),
        *[Path("..") / entry for entry in REPO_ROOT_FILES],
    ]
    return hash_inputs(project_root, entries)


def iter_app_config_entries(project_root: Path) -> list[Path]:
    apps_root = project_root / "src" / "apps"
    if not apps_root.exists():
        return []
    return sorted(config.relative_to(project_root) for config in apps_root.rglob("config.json"))


def hash_module_inputs(project_root: Path) -> str:
    entries = [*MODULE_SOURCE_FILES, Path("assets/compiled/frame_web"), *iter_app_config_entries(project_root)]
    return hash_inputs(project_root, entries)


def frontend_outputs_exist(project_root: Path) -> bool:
    return all((project_root / output).is_file() for output in FRONTEND_OUTPUTS)


def module_outputs_exist(project_root: Path) -> bool:
    return all((project_root / output).is_file() for output in MODULE_OUTPUTS)


def load_manifest(project_root: Path) -> AssetsManifest | None:
    manifest_path = project_root / MANIFEST_PATH
    if not manifest_path.is_file():
        return None

    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None

    if data.get("version") != MANIFEST_VERSION:
        return None

    frontend_hash = data.get("frontend_hash")
    modules_hash = data.get("modules_hash")
    if not isinstance(frontend_hash, str) or not isinstance(modules_hash, str):
        return None

    return AssetsManifest(
        version=MANIFEST_VERSION,
        frontend_hash=frontend_hash,
        modules_hash=modules_hash,
    )


def write_manifest(project_root: Path, frontend_hash: str, modules_hash: str) -> Path:
    manifest_path = project_root / MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": MANIFEST_VERSION,
                "frontend_hash": frontend_hash,
                "modules_hash": modules_hash,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest_path


def resolve_pnpm_command() -> list[str]:
    if shutil.which("corepack"):
        return ["corepack", "pnpm"]
    if shutil.which("pnpm"):
        return ["pnpm"]
    raise RuntimeError("pnpm or corepack is required")


def ensure_frontend_dependencies(project_root: Path) -> None:
    frontend_root = project_root / "frontend"
    if (frontend_root / "node_modules/autoprefixer/package.json").is_file():
        print("Using existing frontend dependencies in frontend/node_modules")
        return

    print("Installing frontend dependencies")
    run_command([*resolve_pnpm_command(), "install", "--frozen-lockfile"], cwd=frontend_root)


def build_frontend(project_root: Path) -> None:
    ensure_frontend_dependencies(project_root)
    print("Building frame frontend")
    run_command([*resolve_pnpm_command(), "run", "build"], cwd=project_root / "frontend")
    if not frontend_outputs_exist(project_root):
        raise RuntimeError("Frame frontend build completed without producing expected assets")


def generate_asset_modules(project_root: Path) -> None:
    print("Generating embedded asset modules")
    python = sys.executable
    commands = (
        [
            python,
            "tools/generate_apps_asset_nim.py",
            "--source-dir",
            ".",
            "--output",
            "src/assets/apps.nim",
        ],
        [
            python,
            "tools/generate_compressed_asset_nim.py",
            "--source-dir",
            ".",
            "--dir",
            "assets/compiled/web",
            "--output",
            "src/assets/web.nim",
        ],
        [
            python,
            "tools/generate_compressed_asset_nim.py",
            "--source-dir",
            ".",
            "--dir",
            "assets/compiled/frame_web",
            "--output",
            "src/assets/frame_web.nim",
        ],
        [
            python,
            "tools/generate_compressed_asset_nim.py",
            "--source-dir",
            ".",
            "--file",
            "assets/compiled/fonts/Ubuntu-Regular.ttf",
            "--output",
            "src/assets/fonts.nim",
        ],
    )

    for command in commands:
        run_command(command, cwd=project_root)

    if not module_outputs_exist(project_root):
        raise RuntimeError("Asset generation completed without producing expected Nim modules")


def prepare_assets(project_root: Path) -> AssetPreparationResult:
    project_root = project_root.resolve()
    (project_root / "src/assets").mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(project_root)
    frontend_hash = hash_frontend_inputs(project_root)
    rebuilt_frontend = not frontend_outputs_exist(project_root) or manifest is None or manifest.frontend_hash != frontend_hash

    if rebuilt_frontend:
        build_frontend(project_root)
    else:
        print("Frame frontend assets are up to date")

    modules_hash = hash_module_inputs(project_root)
    regenerated_modules = not module_outputs_exist(project_root) or manifest is None or manifest.modules_hash != modules_hash

    if regenerated_modules:
        generate_asset_modules(project_root)
    else:
        print("Embedded asset modules are up to date")

    manifest_path = write_manifest(project_root, frontend_hash, modules_hash)
    return AssetPreparationResult(
        rebuilt_frontend=rebuilt_frontend,
        regenerated_modules=regenerated_modules,
        manifest_path=manifest_path,
    )


def main() -> int:
    prepare_assets(Path.cwd())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
