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


DEFAULT_TARGET_FITS = ["cover", "contain", "stretch"]


def _nim_str(value) -> str:
    text = "" if value is None else str(value)
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _nim_str_seq(values) -> str:
    return "@[" + ", ".join(_nim_str(v) for v in values) + "]"


def _nim_constraints(raw) -> str:
    """`{"blendMode": ["normal", "overwrite"]}` -> a seq[FieldConstraint] literal."""
    if not isinstance(raw, dict):
        return "@[]"
    parts = []
    for field, allowed in raw.items():
        if isinstance(allowed, (str, int, float, bool)):
            allowed = [allowed]
        parts.append(
            f"FieldConstraint(field: {_nim_str(field)}, allowed: {_nim_str_seq(allowed)})"
        )
    return "@[" + ", ".join(parts) + "]"


def _nim_matches(raw) -> str:
    """`[{"placement": "contain", "blendMode": "overwrite"}]` -> seq[seq[FieldMatch]]."""
    if not isinstance(raw, list):
        return "@[]"
    clauses = []
    for clause in raw:
        if not isinstance(clause, dict):
            continue
        pairs = ", ".join(
            f"FieldMatch(field: {_nim_str(f)}, value: {_nim_str(v)})" for f, v in clause.items()
        )
        clauses.append("@[" + pairs + "]")
    return "@[" + ", ".join(clauses) + "]"


def _capability_fields(spec: dict) -> list[str]:
    """Every config field a capability spec refers to, in declaration order."""
    names: list[str] = []

    def add(name):
        if isinstance(name, str) and name and name not in names:
            names.append(name)

    add(spec.get("fitFrom"))
    for field in (spec.get("requireStatic") or {}):
        add(field)
    for field in (spec.get("compositingRequireStatic") or {}):
        add(field)
    for field in (spec.get("requireUnset") or []):
        add(field)
    for field in (spec.get("requireOpaqueColor") or []):
        add(field)
    swap_when = spec.get("swapWhen")
    if isinstance(swap_when, dict):
        add(swap_when.get("field"))
    add(spec.get("widthFrom"))
    add(spec.get("heightFrom"))
    for field in (spec.get("multiplyFrom") or []):
        add(field)
    for clause in (spec.get("ownedTargetExcludes") or []):
        if isinstance(clause, dict):
            for field in clause:
                add(field)
    return names


def _field_default(fields: list, name: str) -> str:
    for field in fields:
        if isinstance(field, dict) and field.get("name") == name:
            value = field.get("value")
            if value is None or isinstance(value, (dict, list)):
                return ""
            if isinstance(value, bool):
                return "true" if value else "false"
            return str(value)
    return ""


def _app_capability_literal(config: dict) -> Optional[str]:
    """
    Nim `AppCapabilities(...)` literal for an app's declared port capabilities,
    or None when the app declares none (the materialized floor).

    Input ports declare `providesTarget`, output ports declare `intoTarget` or
    `forwardsTarget`; see frameos/app_capabilities.nim.
    """
    fields = [f for f in (config.get("fields") or []) if isinstance(f, dict)]
    outputs = [o for o in (config.get("output") or []) if isinstance(o, dict)]

    provides: list[str] = []
    into: list[str] = []
    forwards: list[str] = []
    bounds: list[str] = []
    requests: list[str] = []
    referenced: list[str] = []

    def note(spec: dict):
        for name in _capability_fields(spec):
            if name not in referenced:
                referenced.append(name)

    for field in fields:
        capabilities = field.get("capabilities") or {}
        spec = capabilities.get("providesTarget")
        if isinstance(spec, dict):
            note(spec)
            provides.append(
                "ProvidesTargetSpec("
                f"input: {_nim_str(field.get('name'))}, "
                f"fitFrom: {_nim_str(spec.get('fitFrom'))}, "
                f"fits: {_nim_str_seq(spec.get('fits') or DEFAULT_TARGET_FITS)}, "
                f"requireStatic: {_nim_constraints(spec.get('requireStatic'))}, "
                f"compositingRequireStatic: {_nim_constraints(spec.get('compositingRequireStatic'))}, "
                f"requireUnset: {_nim_str_seq(spec.get('requireUnset') or [])}, "
                f"ownedTargetExcludes: {_nim_matches(spec.get('ownedTargetExcludes'))})"
            )

        spec = capabilities.get("requestsBounds")
        if isinstance(spec, dict):
            note(spec)
            requests.append(
                "RequestsBoundsSpec("
                f"input: {_nim_str(field.get('name'))}, "
                f"requireUnset: {_nim_str_seq(spec.get('requireUnset') or [])}, "
                f"multiplyFrom: {_nim_str_seq(spec.get('multiplyFrom') or [])})"
            )

    for output in outputs:
        capabilities = output.get("capabilities") or {}
        spec = capabilities.get("intoTarget")
        if isinstance(spec, dict):
            note(spec)
            into.append(
                "IntoTargetSpec("
                f"output: {_nim_str(output.get('name'))}, "
                f"fits: {_nim_str_seq(spec.get('fits') or DEFAULT_TARGET_FITS)}, "
                f"requireStatic: {_nim_constraints(spec.get('requireStatic'))}, "
                f"requireUnset: {_nim_str_seq(spec.get('requireUnset') or [])}, "
                f"requireOpaqueColor: {_nim_str_seq(spec.get('requireOpaqueColor') or [])})"
            )
        spec = capabilities.get("forwardsTarget")
        if isinstance(spec, dict):
            note(spec)
            forwards.append(
                "ForwardsTargetSpec("
                f"output: {_nim_str(output.get('name'))}, "
                f"input: {_nim_str(spec.get('input'))}, "
                f"requireStatic: {_nim_constraints(spec.get('requireStatic'))})"
            )

        spec = capabilities.get("forwardsBounds")
        if isinstance(spec, dict):
            note(spec)
            swap_when = spec.get("swapWhen") or {}
            bounds.append(
                "ForwardsBoundsSpec("
                f"output: {_nim_str(output.get('name'))}, "
                f"input: {_nim_str(spec.get('input'))}, "
                f"boundsField: {_nim_str(swap_when.get('field'))}, "
                f"swapValues: {_nim_str_seq(swap_when.get('swap') or [])}, "
                f"keepValues: {_nim_str_seq(swap_when.get('keep') or [])}, "
                f"widthFrom: {_nim_str(spec.get('widthFrom'))}, "
                f"heightFrom: {_nim_str(spec.get('heightFrom'))}, "
                f"multiplyFrom: {_nim_str_seq(spec.get('multiplyFrom') or [])})"
            )

    if not provides and not into and not forwards and not bounds and not requests:
        return None

    defaults = ", ".join(
        f"FieldMatch(field: {_nim_str(name)}, value: {_nim_str(_field_default(fields, name))})"
        for name in referenced
    )
    return (
        "AppCapabilities(\n"
        f"      providesTarget: @[{', '.join(provides)}],\n"
        f"      intoTarget: @[{', '.join(into)}],\n"
        f"      forwardsTarget: @[{', '.join(forwards)}],\n"
        f"      forwardsBounds: @[{', '.join(bounds)}],\n"
        f"      requestsBounds: @[{', '.join(requests)}],\n"
        f"      fieldDefaults: @[{defaults}])"
    )


def _app_entry(app_id: str, alias: str, capabilities: set) -> str:
    """One row of the app registry: keyword plus the loader's four entry points.

    Four `case keyword:` chains over ~40 apps used to be ~9 KB of the embedded
    firmware. A sorted table of proc pointers does the same dispatch in a
    binary search, and the rows are data.
    """
    get_proc = f"{alias}.get" if "get" in capabilities else "nil"
    run_proc = f"{alias}.run" if "run" in capabilities else "nil"
    return (
        f'  AppEntry(keyword: "{app_id}", initProc: {alias}.init,'
        f" setFieldProc: {alias}.setField,"
        f" getProc: {get_proc}, runProc: {run_proc}),"
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
        config_path = app_dir / "config.json"
        with config_path.open("r") as f:
            config = json.load(f)
            all_apps[app_id] = config
            app_modules[app_id] = _module_from_app_dir(source_dir, app_dir)
            app_capabilities[app_id] = _app_capabilities(app_dir, config)

    # 1) Imports
    imports: list[str] = [
        "import frameos/types",
        "import frameos/app_capabilities",
        "export app_capabilities",
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

    # 2) the registry table, sorted so lookup can bisect, plus the capability
    #    cases (still a case: those are literals, not calls)
    capability_cases = []
    for app_id, cfg in sorted(all_apps.items(), key=lambda kv: kv[0]):
        literal = _app_capability_literal(cfg)
        if literal:
            capability_cases.append(f'  of "{app_id}":\n    {literal}')
    capability_cases.append("  else: NoAppCapabilities")

    portable = sorted(
        (row for row in items if row[0] not in EMBEDDED_UNAVAILABLE_APPS),
        key=lambda row: row[0],
    )
    host_only = sorted(
        (row for row in items if row[0] in EMBEDDED_UNAVAILABLE_APPS),
        key=lambda row: row[0],
    )
    portable_entries = [_app_entry(*row) for row in portable]
    all_entries = [_app_entry(*row) for row in sorted(items, key=lambda row: row[0])]
    host_only_keywords = ", ".join(f'"{row[0]}"' for row in host_only)

    # 3) Compose Nim
    nl = "\n"
    if host_only:
        table = f"""when defined(frameosEmbedded) or defined(frameosWasm):
  const appEntries = [
{nl.join("  " + line for line in portable_entries)}
  ]
else:
  const appEntries = [
{nl.join("  " + line for line in all_entries)}
  ]

const hostOnlyApps = [{host_only_keywords}]
"""
        host_only_check = """  when defined(frameosEmbedded) or defined(frameosWasm):
    for hostOnly in hostOnlyApps:
      if hostOnly == keyword:
        raise newException(ValueError,
          "App '" & keyword & "' is not available on this build target")
"""
    else:
        table = f"""const appEntries = [
{nl.join(all_entries)}
]
"""
        host_only_check = ""

    code = f"""{nl.join(imports)}

type AppEntry = object
  ## One app's four entry points, so dispatch is a table lookup instead of
  ## four `case keyword:` chains repeated over every app in the registry.
  keyword: string
  initProc: proc (node: DiagramNode, scene: FrameScene): AppRoot {{.nimcall.}}
  setFieldProc: proc (app: AppRoot, field: string, value: Value) {{.nimcall.}}
  getProc: proc (app: AppRoot, context: ExecutionContext): Value {{.nimcall.}}
  runProc: proc (app: AppRoot, context: ExecutionContext) {{.nimcall.}}

{table}
proc appIndex(keyword: string): int =
  ## Bisect the keyword-sorted registry. -1 when this build has no such app.
  var lo = 0
  var hi = appEntries.len - 1
  while lo <= hi:
    let mid = (lo + hi) div 2
    if appEntries[mid].keyword == keyword: return mid
    elif appEntries[mid].keyword < keyword: lo = mid + 1
    else: hi = mid - 1
  -1

proc raiseUnknownApp(keyword: string) =
{host_only_check}  raise newException(ValueError, "Unknown app keyword: " & keyword)

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  let i = appIndex(keyword)
  if i < 0: raiseUnknownApp(keyword)
  appEntries[i].initProc(node, scene)

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  let i = appIndex(keyword)
  if i < 0: raiseUnknownApp(keyword)
  appEntries[i].setFieldProc(app, field, value)

proc runApp*(keyword: string, app: AppRoot, context: ExecutionContext) =
  let i = appIndex(keyword)
  if i < 0 or appEntries[i].runProc == nil:
    raise newException(Exception, "App '" & keyword & "' cannot be run; use get().")
  appEntries[i].runProc(app, context)

proc getApp*(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  let i = appIndex(keyword)
  if i < 0 or appEntries[i].getProc == nil: raiseUnknownApp(keyword)
  appEntries[i].getProc(app, context)

proc appCapabilities*(keyword: string): AppCapabilities =
  ## Per-port protocols this app declares in its config.json. Apps that
  ## declare nothing are materialized-only, which every edge supports.
  case keyword:
{nl.join(capability_cases)}
"""
    return code
