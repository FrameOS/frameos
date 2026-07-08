from __future__ import annotations
import json
import os
import re
from pathlib import Path
from typing import Optional

# from ..models.frame import Frame
# from ..models.apps import get_apps_from_scenes

EMBEDDED_UNAVAILABLE_APPS = {
    "data/chromiumScreenshot",
    "data/rstpSnapshot",
}


def _alias_from_id(app_id: str) -> str:
    """
    Turn an app id (e.g. 'render/image' or 'nodeapp_deadbeef') into a safe Nim alias.
    Ensures it starts with a letter and uses only [a-zA-Z0-9_].
    """
    alias = re.sub(r'[^0-9a-zA-Z_]', '_', app_id)
    if alias and alias[0].isdigit():
        alias = "_" + alias
    return alias


def _module_from_app_dir(source_dir: Path, app_dir: Path) -> str:
    """
    App loader Nim module path from src/apps/apps.nim.
    """
    app_loader = app_dir / "app_loader"
    src_root = source_dir / "src"
    try:
        module_path = app_loader.relative_to(src_root)
    except ValueError:
        module_path = Path(os.path.relpath(app_loader, source_dir / "src" / "apps"))
    return str(module_path).replace(os.sep, "/")


def _iter_config_app_dirs(apps_root: Path):
    if not apps_root.exists():
        return
    for category_dir in sorted(apps_root.iterdir()):
        if not category_dir.is_dir():
            continue
        if (category_dir / "config.json").exists():
            yield category_dir.name, category_dir
        for app_dir in sorted(category_dir.iterdir()):
            if not app_dir.is_dir():
                continue
            if (app_dir / "config.json").exists():
                yield f"{category_dir.name}/{app_dir.name}", app_dir


def _app_has_proc(app_dir: Path, proc_name: str) -> bool:
    app_file = app_dir / "app.nim"
    if not app_file.exists():
        return False

    app_source = app_file.read_text()
    return re.search(
        rf"proc\s+{re.escape(proc_name)}\*?\s*\(\s*[A-Za-z_]\w*\s*:\s*(?:var\s+)?App\b",
        app_source,
    ) is not None


def _app_capabilities(app_dir: Path, config: dict) -> set[str]:
    capabilities: set[str] = set()
    if _app_has_proc(app_dir, "get"):
        capabilities.add("get")
    if _app_has_proc(app_dir, "run"):
        capabilities.add("run")

    if capabilities:
        return capabilities

    category = (config.get("category") or "").strip().lower()
    if category in ("data", "render"):
        capabilities.add("get")
    if category in ("logic", "render"):
        capabilities.add("run")
    return capabilities


def _app_call_case(app_id: str, call: str) -> str:
    if app_id not in EMBEDDED_UNAVAILABLE_APPS:
        return f'  of "{app_id}": {call}'

    error = f"App '{app_id}' is not available on this build target"
    return "\n".join(
        [
            f'  of "{app_id}":',
            "    when defined(frameosEmbedded) or defined(frameosWasm):",
            f'      raise newException(ValueError, "{error}")',
            "    else:",
            f"      {call}",
        ]
    )


def write_apps_nim(tmp_dir: Optional[str] = None) -> str:
    """
    Generate src/apps/apps.nim with a registry covering all discovered apps.

    all_apps: mapping of app_id → config (parsed config.json).
              app_id is typically the keyword (e.g., 'render/image', 'data/newImage'),
              or 'nodeapp_<uuid>' for per-scene generated apps.
    """
    if not tmp_dir:
        tmp_dir = os.environ.get("FRAMEOS_ROOT_DIR", "frameos")
    source_dir = Path(os.path.abspath(tmp_dir))

    # find all apps
    all_apps = {}
    app_modules = {}
    app_capabilities = {}
    for app_id, app_dir in _iter_config_app_dirs(source_dir / "src" / "apps"):
        if app_id.startswith("legacy"):
            continue
        config_path = app_dir / "config.json"
        with config_path.open("r") as f:
            config = json.load(f)
            all_apps[app_id] = config
            app_modules[app_id] = _module_from_app_dir(source_dir, app_dir)
            app_capabilities[app_id] = _app_capabilities(app_dir, config)

    # 1) Imports
    imports: list[str] = [
        "import frameos/types",
    ]
    embedded_unavailable_imports: list[str] = []
    used_aliases: set[str] = set()
    items = []

    for app_id, cfg in sorted(all_apps.items(), key=lambda kv: kv[0]):
        mod = app_modules[app_id]
        alias_base = _alias_from_id(app_id) + "_loader"
        alias = alias_base
        n = 2
        while alias in used_aliases:
            alias = f"{alias_base}_{n}"
            n += 1
        used_aliases.add(alias)
        import_line = f"import {mod} as {alias}"
        if app_id in EMBEDDED_UNAVAILABLE_APPS:
            embedded_unavailable_imports.append(import_line)
        else:
            imports.append(import_line)
        items.append((app_id, alias, app_capabilities.get(app_id, set())))

    if embedded_unavailable_imports:
        imports.append("when not defined(frameosEmbedded) and not defined(frameosWasm):")
        imports.append("  # Excluded from embedded and wasm builds: these apps depend on host-only")
        imports.append("  # runtime features such as child processes and external binaries.")
        imports.extend(f"  {import_line}" for import_line in embedded_unavailable_imports)

    # 2) case branches
    init_cases = []
    set_cases  = []
    run_cases  = []
    get_cases  = []

    for app_id, alias, capabilities in items:
        init_cases.append(_app_call_case(app_id, f"{alias}.init(node, scene)"))
        set_cases.append(_app_call_case(app_id, f"{alias}.setField(app, field, value)"))

        if "run" in capabilities:
            run_cases.append(_app_call_case(app_id, f"{alias}.run(app, context)"))
        if "get" in capabilities:
            get_cases.append(_app_call_case(app_id, f"{alias}.get(app, context)"))

    init_cases.append('  else: raise newException(ValueError, "Unknown app keyword: " & keyword)')
    set_cases.append('  else: raise newException(ValueError, "Unknown app keyword: " & keyword)')
    get_cases.append('  else: raise newException(ValueError, "Unknown app keyword: " & keyword)')
    # run: include a helpful default error
    run_cases.append('  else: raise newException(Exception, "App \'" & keyword & "\' cannot be run; use get().")')

    # 3) Compose Nim
    nl = "\n"
    code = f"""{nl.join(imports)}

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  case keyword:
{nl.join(init_cases)}

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  case keyword:
{nl.join(set_cases)}

proc runApp*(keyword: string, app: AppRoot, context: ExecutionContext) =
  case keyword:
{nl.join(run_cases)}

proc getApp*(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  case keyword:
{nl.join(get_cases)}
"""
    return code
