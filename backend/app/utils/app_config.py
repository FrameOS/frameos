"""An app's config.json, read the one way every reader reads it.

A JavaScript app's config.json is what it asks for: its `permissions`, the
settings it reads. The frame gives the app exactly that, and every surface
that shows or approves it reads the same file, so the readers must agree on
what the file says: strict JSON (RFC 8259), an object, at most
``APP_CONFIG_MAX_DEPTH`` containers deep. A text that is not all three is no
config. The frame gives such an app nothing
(frameos/src/frameos/utils/strict_json.nim), and no door here saves a scene
that carries one (``bad_app_configs_message``): a file only one parser could
read asked for things nobody was shown.

docs/app-config-fixtures.json is the corpus this, the runtime and the SPA
(frontend/src/utils/sceneAccess.ts ``parseAppConfig``) replay.
"""
from __future__ import annotations

import json
from typing import Any

__all__ = [
    "APP_CONFIG_MAX_DEPTH",
    "bad_app_configs_message",
    "parse_app_config",
    "scene_app_config_problem",
]

APP_CONFIG_MAX_DEPTH = 32


def _refuse_constant(name: str) -> Any:
    # json.loads reads NaN, Infinity and -Infinity; JSON has none of them.
    raise ValueError(f"{name} is not JSON")


def _within_depth(value: Any, depth: int) -> bool:
    if not isinstance(value, (dict, list)):
        return True
    if depth <= 0:
        return False
    items = value.values() if isinstance(value, dict) else value
    return all(_within_depth(item, depth - 1) for item in items)


def parse_app_config(text: Any) -> dict[str, Any] | None:
    """The config `text` is, or None when it is not one."""
    if not isinstance(text, str):
        return None
    try:
        value = json.loads(text, parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        return None
    if not isinstance(value, dict) or not _within_depth(value, APP_CONFIG_MAX_DEPTH):
        return None
    return value


def _broken(sources: Any) -> bool:
    return isinstance(sources, dict) and "config.json" in sources and parse_app_config(sources["config.json"]) is None


def scene_app_config_problem(scene: Any) -> str | None:
    """The first app of the scene (one of its apps, or a node's own files)
    whose config.json is not one, in words; None when every one is."""
    if not isinstance(scene, dict):
        return None

    def named(keyword: Any) -> str:
        scene_name = scene.get("name") or scene.get("id")
        where = f" in scene \"{scene_name}\"" if isinstance(scene_name, str) and scene_name else ""
        return (
            f"App \"{keyword}\"{where}: config.json is not valid JSON. "
            "Fix the file (no comments, no trailing commas) and save again."
        )

    apps = scene.get("apps")
    for keyword, app in (apps.items() if isinstance(apps, dict) else ()):
        if isinstance(app, dict) and _broken(app.get("sources")):
            return named(keyword)
    nodes = scene.get("nodes")
    for node in nodes if isinstance(nodes, list) else ():
        data = node.get("data") if isinstance(node, dict) else None
        if isinstance(node, dict) and node.get("type") == "app" and isinstance(data, dict) and _broken(data.get("sources")):
            return named(data.get("keyword") or node.get("id") or "app")
    return None


def bad_app_configs_message(scenes: Any) -> str | None:
    """What is wrong with the scenes' apps' config.json files, None when
    nothing is: what a save, an import or a push of them is refused with."""
    for scene in scenes if isinstance(scenes, list) else ():
        problem = scene_app_config_problem(scene)
        if problem:
            return problem
    return None
