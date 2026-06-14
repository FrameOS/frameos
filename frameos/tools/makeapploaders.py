from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any


FRAMEOS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = FRAMEOS_DIR.parent
BACKEND_CODEGEN_DIR = REPO_ROOT / "backend" / "app" / "codegen"


def load_codegen_attr(module_name: str, filename: str, attr: str) -> Any:
    module_path = BACKEND_CODEGEN_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, attr)


write_app_loader_nim = load_codegen_attr("app_loader_nim", "app_loader_nim.py", "write_app_loader_nim")
write_apps_nim = load_codegen_attr("apps_nim", "apps_nim.py", "write_apps_nim")


def iter_app_dirs(apps_root: Path):
    if not apps_root.is_dir():
        return
    for category_dir in sorted(apps_root.iterdir()):
        if not category_dir.is_dir():
            continue
        for app_dir in sorted(category_dir.iterdir()):
            if app_dir.is_dir() and (app_dir / "config.json").exists():
                yield app_dir


def write_generated_app_files(app_dir: Path) -> None:
    (app_dir / "app_loader.nim").write_text(write_app_loader_nim(str(app_dir)))


def main() -> None:
    source_dir = Path(os.environ.get("FRAMEOS_ROOT_DIR", str(FRAMEOS_DIR))).resolve()

    (source_dir / "src" / "apps").mkdir(parents=True, exist_ok=True)
    for app_dir in iter_app_dirs(source_dir / "src" / "apps"):
        write_generated_app_files(app_dir)

    (source_dir / "src" / "apps" / "apps.nim").write_text(write_apps_nim(str(source_dir)))


if __name__ == "__main__":
    main()
