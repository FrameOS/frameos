# app_codegen/apps_nim.py
from __future__ import annotations
import json
import os
import re
from glob import glob
from typing import Optional

# from ..models.frame import Frame
# from ..models.apps import get_apps_from_scenes

def _alias_from_id(app_id: str) -> str:
    """
    Turn an app id (e.g. 'render/image' or 'nodeapp_deadbeef') into a safe Nim alias.
    Ensures it starts with a letter and uses only [a-zA-Z0-9_].
    """
    alias = re.sub(r'[^0-9a-zA-Z_]', '_', app_id)
    if alias and alias[0].isdigit():
        alias = "_" + alias
    return alias

def _module_from_id(app_id: str) -> str:
    """
    App loader Nim module path from id (works for both 'a/b' and 'nodeapp_x').
    """
    return f"apps/{app_id}/app_loader"

def write_apps_nim(tmp_dir: Optional[str] = None) -> str:
    """
    Generate src/apps/apps.nim with a registry covering all discovered apps.

    all_apps: mapping of app_id → config (parsed config.json).
              app_id is typically the keyword (e.g., 'render/image', 'data/newImage'),
              or 'nodeapp_<uuid>' for per-scene generated apps.
    """
    if not tmp_dir:
        tmp_dir = os.environ.get("FRAMEOS_ROOT_DIR", "frameos")
    source_dir = os.path.abspath(tmp_dir)

    # find all apps
    all_apps = {}
    for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
        config_path = os.path.join(app_dir, "config.json")
        if os.path.exists(config_path):
            with open(config_path, "r") as f:
                id = f"{app_dir.split('/')[-2]}/{app_dir.split('/')[-1]}"
                if id.startswith("legacy"):
                    continue
                config = json.load(f)
                all_apps[id] = config

    # if frame:
    #     for node_id, sources in get_apps_from_scenes(list(frame.scenes)).items():
    #         app_id = "nodeapp_" + node_id.replace('-', '_')
    #         app_dir = os.path.join(source_dir, "src", "apps", app_id)
    #         os.makedirs(app_dir, exist_ok=True)
    #         for filename, code in sources.items():
    #             with open(os.path.join(app_dir, filename), "w") as f:
    #                 f.write(code)
    #         config_json = sources["config.json"] if "config.json" in sources else '{}'
    #         config = json.loads(config_json)
    #         all_apps[app_id] = config

    # 1) Imports
    imports: list[str] = [
        "import frameos/types",
    ]
    used_aliases: set[str] = set()
    items = []

    for app_id, cfg in sorted(all_apps.items(), key=lambda kv: kv[0]):
        mod = _module_from_id(app_id)
        alias_base = _alias_from_id(app_id) + "_loader"
        alias = alias_base
        n = 2
        while alias in used_aliases:
            alias = f"{alias_base}_{n}"
            n += 1
        used_aliases.add(alias)
        imports.append(f"import {mod} as {alias}")
        items.append((app_id, alias, (cfg.get("category") or "").strip().lower()))

    # 2) case branches
    init_cases = []
    set_cases  = []
    run_cases  = []
    get_cases  = []

    for app_id, alias, category in items:
        init_cases.append(f'  of "{app_id}": {alias}.init(node, scene)')
        set_cases.append(f'  of "{app_id}": {alias}.setField(app, field, value)')

        if category == "render":
            run_cases.append(f'  of "{app_id}": {alias}.run(app, context)')
            get_cases.append(f'  of "{app_id}": {alias}.get(app, context)')
        elif category == "logic":
            run_cases.append(f'  of "{app_id}": {alias}.run(app, context)')
        else:
            get_cases.append(f'  of "{app_id}": {alias}.get(app, context)')

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
