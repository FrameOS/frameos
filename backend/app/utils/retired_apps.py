"""Built-in Nim apps retired in favour of a repo JavaScript app.

Eleven of them so far (data/immich, data/frameOSGallery, render/chart, …): each
became the scene-local JS app of the same name from `repo/apps/<folder>/`, which
runs on the runtime its `runtime` names and later. A retired render app's node
in the render flow becomes the app its `renderFlow` names (render/image), fed
by a new node of the replacement.
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
        "replacement": "repo/apps/image/immich",
        "sceneAppKey": "immich",
        "runtime": "2026.10.11",
        "needs": "frameos.fetchImage",
    },
    "data/frameOSGallery": {
        "replacement": "repo/apps/image/frameOSGallery",
        "sceneAppKey": "frameOSGallery",
        "runtime": "2026.10.13",
        "needs": "a throw in get() failing the node (the painted error)",
    },
    "data/unsplash": {
        "replacement": "repo/apps/image/unsplash",
        "sceneAppKey": "unsplash",
        "runtime": "2026.10.13",
        "needs": "a throw in get() failing the node (the painted error)",
    },
    "data/wikicommons": {
        "replacement": "repo/apps/image/wikicommons",
        "sceneAppKey": "wikicommons",
        "runtime": "2026.10.13",
        "needs": "a throw in get() failing the node (the painted error)",
    },
    "data/googlePhotos": {
        "replacement": "repo/apps/image/googlePhotos",
        "sceneAppKey": "googlePhotos",
        "runtime": "2026.10.13",
        "needs": "frameos.remember (the album list outlives an ESP32 render)",
    },
    "data/openaiImage": {
        "replacement": "repo/apps/image/openaiImage",
        "sceneAppKey": "openaiImage",
        "runtime": "2026.10.13",
        "needs": "app.frame.embedded and saving a data: URL (the b64_json reply)",
    },
    "data/openaiText": {
        "replacement": "repo/apps/text/openaiText",
        "sceneAppKey": "openaiText",
        "runtime": "2026.10.11",
        "needs": "frameos.httpRequest",
    },
    "data/haSensor": {
        "replacement": "repo/apps/json/haSensor",
        "sceneAppKey": "haSensor",
        "runtime": "2026.10.11",
        "needs": "frameos.httpRequest",
    },
    "data/weather": {
        "replacement": "repo/apps/json/weather",
        "sceneAppKey": "weather",
        "runtime": "2026.10.11",
        "needs": "frameos.httpRequest",
    },
    "data/beRecycle": {
        "replacement": "repo/apps/json/beRecycle",
        "sceneAppKey": "beRecycle",
        "runtime": "2026.10.13",
        "needs": "a throw in get() failing the node",
    },
    "render/chart": {
        "replacement": "repo/apps/image/chart",
        "sceneAppKey": "chart",
        "runtime": "2026.10.13",
        "needs": "nothing new: an older frame keeps the built-in chart it has",
        "renderFlow": "render/image",
    },
    "data/eventsToAgenda": {
        "replacement": "repo/apps/text/eventsToAgenda",
        "sceneAppKey": "eventsToAgenda",
        "runtime": "2026.10.22",
        "needs": "nothing new: an older frame keeps the built-in agenda it has",
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


def retired_app_config(keyword: str | None) -> dict[str, Any] | None:
    """The replacement's config.json for a retired keyword, for readers that
    look an app up by keyword (the settings it declares, its fields) and meet
    a scene that was not converted yet. None for any other keyword."""
    spec = RETIRED_APPS.get(keyword or "")
    if spec is None:
        return None
    entry = _replacement_app_entry(spec["replacement"])
    return {key: value for key, value in entry.items() if key not in ("origin", "sources")}


def _repo_app_name(origin: Any) -> str | None:
    """The app an origin names, `repo/apps/<folder>/<name>` → name. Origins
    compare by it: the folder moved once (every app was under repo/apps/code
    until 2026.10.13), and scenes saved before still name the old one."""
    if isinstance(origin, str):
        parts = origin.split("/")
        if len(parts) == 4 and parts[:2] == ["repo", "apps"] and parts[3]:
            return parts[3]
    return None


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
                (
                    name
                    for name, app in apps.items()
                    if isinstance(app, dict) and _repo_app_name(app.get("origin")) == _repo_app_name(origin)
                ),
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
        consumer = spec.get("renderFlow")
        for node in nodes:
            if consumer and _in_render_flow(scene, node):
                _feed_from_new_node(scene, node, key, consumer, _field_names(origin))
            else:
                node["data"]["keyword"] = key
        changed = True
    return changed


def _field_names(origin: str) -> set[str]:
    fields = _replacement_app_entry(origin).get("fields") or []
    return {field["name"] for field in fields if isinstance(field, dict) and isinstance(field.get("name"), str)}


def _edges(scene: dict) -> list:
    edges = scene.get("edges")
    if not isinstance(edges, list):
        edges = scene["edges"] = []
    return edges


def _in_render_flow(scene: dict, node: dict) -> bool:
    """Whether the render flow runs this node: an edge into its `prev` (from the
    previous app, or from a layout's `field/...` cell) or out of its `next`."""
    node_id = node.get("id")
    return any(
        isinstance(edge, dict)
        and (
            (edge.get("target") == node_id and edge.get("targetHandle") == "prev")
            or (edge.get("source") == node_id and edge.get("sourceHandle") == "next")
        )
        for edge in _edges(scene)
    )


def _unused_id(base: str, taken: set) -> str:
    candidate, suffix = base, 2
    while candidate in taken:
        candidate, suffix = f"{base}{suffix}", suffix + 1
    return candidate


def _feed_from_new_node(scene: dict, node: dict, key: str, consumer: str, fields: set[str]) -> None:
    """A retired render app in the render flow: the node stays where it is, as
    `consumer` (render/image), and a new node of the replacement app, with the
    old node's config, cache and field edges, feeds its image."""
    nodes = scene["nodes"]
    edges = _edges(scene)
    data = node["data"]
    node_id = node.get("id")
    new_id = _unused_id(f"{node_id}-{key}", {entry.get("id") for entry in nodes if isinstance(entry, dict)})
    new_data: dict[str, Any] = {"keyword": key, "config": data.get("config") or {}}
    if "cache" in data:
        new_data["cache"] = data["cache"]
    new_node: dict[str, Any] = {"id": new_id, "type": "app", "data": new_data}
    position = node.get("position")
    if isinstance(position, dict) and isinstance(position.get("x"), (int, float)) and isinstance(position.get("y"), (int, float)):
        new_node["position"] = {"x": position["x"], "y": position["y"] - 150}
    nodes.insert(nodes.index(node) + 1, new_node)
    node["data"] = {"keyword": consumer, "config": {}}
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("target") != node_id:
            continue
        handle = edge.get("targetHandle")
        if isinstance(handle, str) and handle.startswith("fieldInput/") and handle[len("fieldInput/"):] in fields:
            edge["target"] = new_id
    edges.append({
        "id": _unused_id(f"{new_id}-image", {edge.get("id") for edge in edges if isinstance(edge, dict)}),
        "type": "codeNodeEdge",
        "source": new_id,
        "sourceHandle": "fieldOutput",
        "target": node_id,
        "targetHandle": "fieldInput/image",
    })


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
    by_name = {
        _repo_app_name(spec["replacement"]): keyword for keyword, spec in RETIRED_APPS.items() if keyword in selected
    }
    changed = False
    for key in list(apps):
        app = apps[key]
        name = _repo_app_name(app.get("origin")) if isinstance(app, dict) else None
        keyword = by_name.get(name) if name else None
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


APP_TEST_FILE_SUFFIXES = (".test.ts", ".test.tsx", ".test.js", ".test.jsx")


def is_app_test_file(name: str) -> bool:
    """`<name>.test.ts` (or .tsx/.js/.jsx): a JavaScript app's own tests,
    run in the editor (docs/js-apps-and-code-nodes.md, "Testing an app")."""
    return name.lower().endswith(APP_TEST_FILE_SUFFIXES)


def strip_app_test_files(scenes: list) -> list:
    """`scenes` with every app's test files taken out of its `sources`, in
    place: an ESP32 keeps all its scenes in 512 KiB and never runs them."""
    for scene in scenes:
        apps = scene.get("apps") if isinstance(scene, dict) else None
        if not isinstance(apps, dict):
            continue
        for app in apps.values():
            sources = app.get("sources") if isinstance(app, dict) else None
            if isinstance(sources, dict):
                for name in [name for name in sources if isinstance(name, str) and is_app_test_file(name)]:
                    del sources[name]
    return scenes


def scenes_for_runtime(scenes: Any, runtime_version: str | None) -> list:
    """A copy of `scenes` as a runtime of `runtime_version` must receive them."""
    result = copy.deepcopy(scenes) if isinstance(scenes, list) else []
    lacking = keywords_runtime_lacks(runtime_version)
    restore_apps_in_scenes(result, lacking)
    retire_apps_in_scenes(result, [keyword for keyword in RETIRED_APPS if keyword not in lacking])
    return result


def scenes_for_embedded_runtime(scenes: Any, runtime_version: str | None) -> list:
    """As scenes_for_runtime, for an ESP32: also without the apps' test files."""
    return strip_app_test_files(scenes_for_runtime(scenes, runtime_version))
