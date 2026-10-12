"""Built-in Nim apps retired in favour of a repo JavaScript app.

`data/immich` became the scene-local JS app from `repo/apps/code/immich`,
which needs `frameos.fetchImage` and so a runtime from 2026.10.11 on.
`docs/retired-apps.json` is the contract (RETIRED_APPS below is its copy,
pinned by test_retired_apps.py), docs/retired-apps.md the prose, and
docs/retired-apps-fixtures.json the corpus this module and the cloud's
`retired-apps.ts` must both reproduce.

- `retire_apps_in_scenes` rewrites a retired keyword into the JS app. It runs
  on every scene the backend stores: the alembic migration, template import,
  backup restore, scene pulls from devices, and the frame form's save.
- `scenes_for_runtime` is what a device is sent: a runtime older than the
  replacement still has the Nim app and lacks what the JS app needs, so it
  gets the retired keyword back; every other runtime, and an unknown one,
  gets the JS app.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from app.utils.versions import version_tuple

REPO_ROOT = Path(__file__).resolve().parents[3]

RETIRED_APPS: dict[str, dict[str, str]] = {
    "data/immich": {
        "replacement": "repo/apps/code/immich",
        "sceneAppKey": "immich",
        "runtime": "2026.10.11",
        "needs": "frameos.fetchImage",
    },
}


def replacement_app_entry(origin: str) -> dict[str, Any]:
    """The scene-local app a repo JS app becomes: its config.json keys plus
    `origin` and `sources` (every file of the folder) — the shape the editor
    and the cloud's AI bundle repo apps in (`bundleRepoApps`)."""
    return copy.deepcopy(_replacement_app_entry(origin))


@lru_cache(maxsize=None)
def _replacement_app_entry(origin: str) -> dict[str, Any]:
    app_dir = REPO_ROOT / origin
    config = json.loads((app_dir / "config.json").read_text())
    sources = {
        path.name: path.read_text()
        for path in sorted(app_dir.iterdir())
        if path.is_file() and not path.name.endswith(".nim")
    }
    return {**config, "origin": origin, "sources": sources}


def _app_nodes(scene: dict) -> list[dict]:
    nodes = scene.get("nodes")
    if not isinstance(nodes, list):
        return []
    return [
        node
        for node in nodes
        if isinstance(node, dict) and node.get("type") == "app" and isinstance(node.get("data"), dict)
    ]


def _scene_apps(scene: dict) -> dict | None:
    apps = scene.get("apps")
    return apps if isinstance(apps, dict) else None


def retire_apps_in_scene(scene: Any, keywords: Iterable[str] | None = None) -> bool:
    """Rewrite retired keywords in one scene, in place. Returns whether it changed.

    A node that carries its own `data.sources` is a self-contained edited copy
    and is left alone, as legacy_app_migration does."""
    if not isinstance(scene, dict):
        return False
    selected = set(RETIRED_APPS if keywords is None else keywords)
    changed = False
    for keyword, spec in RETIRED_APPS.items():
        if keyword not in selected:
            continue
        origin = spec["replacement"]
        nodes = [
            node
            for node in _app_nodes(scene)
            if node["data"].get("keyword") == keyword and not node["data"].get("sources")
        ]
        if not nodes:
            continue
        apps = _scene_apps(scene)
        key = None
        if apps:
            key = next(
                (name for name, app in apps.items() if isinstance(app, dict) and app.get("origin") == origin),
                None,
            )
        if key is None:
            if apps is None:
                apps = scene["apps"] = {}
            base = spec["sceneAppKey"]
            key, suffix = base, 2
            while key in apps:
                key, suffix = f"{base}{suffix}", suffix + 1
            apps[key] = replacement_app_entry(origin)
        for node in nodes:
            node["data"]["keyword"] = key
        changed = True
    return changed


def retire_apps_in_scenes(scenes: Any, keywords: Iterable[str] | None = None) -> bool:
    if not isinstance(scenes, list):
        return False
    changed = False
    for scene in scenes:
        changed = retire_apps_in_scene(scene, keywords) or changed
    return changed


def restore_apps_in_scene(scene: Any, keywords: Iterable[str] | None = None) -> bool:
    """Give a runtime that predates the replacements the retired keywords back,
    in place: every node of a scene-local app whose `origin` is a replacement
    gets the retired keyword, and the entry goes (and `apps` with it, once
    empty). Returns whether it changed."""
    apps = _scene_apps(scene) if isinstance(scene, dict) else None
    if not apps:
        return False
    selected = set(RETIRED_APPS if keywords is None else keywords)
    by_origin = {
        spec["replacement"]: keyword for keyword, spec in RETIRED_APPS.items() if keyword in selected
    }
    changed = False
    for key in list(apps):
        app = apps[key]
        origin = app.get("origin") if isinstance(app, dict) else None
        keyword = by_origin.get(origin) if isinstance(origin, str) else None
        if keyword is None:
            continue
        for node in _app_nodes(scene):
            if node["data"].get("keyword") == key:
                node["data"]["keyword"] = keyword
        del apps[key]
        changed = True
    if changed and not apps:
        del scene["apps"]
    return changed


def restore_apps_in_scenes(scenes: Any, keywords: Iterable[str] | None = None) -> bool:
    if not isinstance(scenes, list):
        return False
    changed = False
    for scene in scenes:
        changed = restore_apps_in_scene(scene, keywords) or changed
    return changed


def keywords_runtime_lacks(runtime_version: str | None) -> list[str]:
    """The retired keywords whose replacement this runtime cannot run yet.
    Unknown counts as none: a frame that never told us its version is a fresh
    install of the release this backend carries (the same rule as the command
    queue's floor in utils/embedded_commands.py)."""
    reported = version_tuple(runtime_version)
    if reported is None:
        return []
    lacking = []
    for keyword, spec in RETIRED_APPS.items():
        floor = version_tuple(spec["runtime"])
        if floor is not None and reported < floor:
            lacking.append(keyword)
    return lacking


def frame_runtime_version(frame: Any) -> str | None:
    """The FrameOS a frame runs as far as this backend knows: its last bootup
    line, else its deploy baseline (models/log.py keeps both current). An
    ESP32 posts its bootup line, synchronously, before the first scenes pull
    of a boot (main.c log_bootup_event), so the pull right after an OTA is
    already judged by the new version."""
    from app.models.log import _known_frameos_version

    return _known_frameos_version(frame)


def scenes_for_runtime(scenes: Any, runtime_version: str | None) -> list:
    """A copy of `scenes` as a runtime of `runtime_version` must receive them."""
    result = copy.deepcopy(scenes) if isinstance(scenes, list) else []
    lacking = keywords_runtime_lacks(runtime_version)
    restore_apps_in_scenes(result, lacking)
    retire_apps_in_scenes(result, [keyword for keyword in RETIRED_APPS if keyword not in lacking])
    return result
