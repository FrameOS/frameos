"""One rule for a scene's execution mode: explicit wins, absent means interpreted.

Every scene created by the UI since 2026 is stamped ``settings.execution:
"interpreted"``; compiled scenes are the legacy path, kept for scenes that
carry inline Nim (app sources, Nim-only code nodes, source nodes) which the
interpreter cannot run. Until 2026-08 an *absent* key was read as
``compiled`` by five separate call sites - so any scene that arrived without
the key (templates, imports, chat-built scenes, cloud pulls) silently forced
a source build and, on Home Assistant installs with no Docker socket, a
failed one.

The migration ``c3d5e7f9a1b2`` stamps existing frames and templates once
using :func:`normalize_scene_execution`; the ingest paths call the same
function so scenes from outside the database get a key the moment they
enter. Readers use :func:`scene_execution`, which never guesses beyond
"absent = interpreted".
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from app.utils.js_apps import find_js_app_source_key

VALID_SCENE_EXECUTIONS: frozenset[str] = frozenset({"compiled", "interpreted"})
DEFAULT_SCENE_EXECUTION = "interpreted"


def _has_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def sources_require_compilation(sources: object) -> bool:
    """Nim app sources with no JavaScript sibling: only the compiler can run them."""
    if not isinstance(sources, dict):
        return False
    if not (_has_text(sources.get("app.nim")) or _has_text(sources.get("config.nim"))):
        return False
    return find_js_app_source_key(sources) is None


def scene_requires_compilation(scene: object) -> bool:
    """Mirror of ``sceneRequiresCompilation`` in frontend/src/utils/sceneApps.ts.

    True when the scene holds content the interpreter refuses: Nim-only app
    sources (on the scene's apps or on an app node), a code node written in
    Nim with no JavaScript twin, or a source node.
    """
    if not isinstance(scene, dict):
        return False
    apps = scene.get("apps") if isinstance(scene.get("apps"), dict) else {}
    for app in apps.values():
        if isinstance(app, dict) and sources_require_compilation(app.get("sources")):
            return True

    for node in scene.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_type = node.get("type")
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        if node_type == "source":
            return True
        if node_type == "app":
            if sources_require_compilation(data.get("sources")):
                return True
            keyword = data.get("keyword")
            scene_app = apps.get(keyword) if isinstance(keyword, str) else None
            if isinstance(scene_app, dict) and sources_require_compilation(scene_app.get("sources")):
                return True
        elif node_type == "code":
            if _has_text(data.get("code")) and not _has_text(data.get("codeJS")):
                return True
    return False


def explicit_scene_execution(scene: object) -> str | None:
    """The stored value when it is one of the known modes, else None."""
    if not isinstance(scene, dict):
        return None
    settings = scene.get("settings")
    if not isinstance(settings, dict):
        return None
    value = settings.get("execution")
    return value if value in VALID_SCENE_EXECUTIONS else None


def scene_execution(scene: object) -> str:
    """``"compiled"`` or ``"interpreted"``; absent or unknown reads as interpreted."""
    return explicit_scene_execution(scene) or DEFAULT_SCENE_EXECUTION


def scene_is_interpreted(scene: object) -> bool:
    return scene_execution(scene) == "interpreted"


def infer_scene_execution(scene: object) -> str:
    """What an unstamped scene should be stamped with."""
    return "compiled" if scene_requires_compilation(scene) else DEFAULT_SCENE_EXECUTION


def normalize_scene_execution(scene: Any) -> bool:
    """Materialize ``settings.execution`` in place. Returns True when it changed.

    Explicit values are left alone, even a ``compiled`` on a scene that no
    longer needs it - that is the user's call, made in the scene settings.
    """
    if not isinstance(scene, dict):
        return False
    if explicit_scene_execution(scene) is not None:
        return False
    settings = scene.get("settings")
    if not isinstance(settings, dict):
        settings = {}
        scene["settings"] = settings
    settings["execution"] = infer_scene_execution(scene)
    return True


def normalize_scenes_execution(scenes: Iterable[Any] | None) -> bool:
    """normalize_scene_execution over a list; True when any scene changed."""
    if not isinstance(scenes, list):
        return False
    changed = False
    for scene in scenes:
        if normalize_scene_execution(scene):
            changed = True
    return changed
