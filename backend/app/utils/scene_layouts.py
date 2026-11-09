"""What can be a layout (docs/scene-layouts.md).

A layout's render is one JSX app, drawn to the frame, with a ``<yield />``:
that shape is what lets the runtime draw around the scene it wraps. The SPA's
copy is ``sceneLayoutProblem`` in ``frontend/src/utils/sceneLayoutRule.ts``, and
``docs/scene-layout-fixtures.json`` pins the two together.
"""

from __future__ import annotations

import re
from typing import Any

_JSX_FILE = re.compile(r"\.[jt]sx$")
_YIELD_TAG = re.compile(r"<\s*yield\b")

_PROBLEM_TEXT = {
    "render": "A layout draws one JSX app to the frame and nothing else.",
    "app": "A layout has to be a JSX app (an app.tsx).",
    "yield": "A layout needs a <yield /> where the scene it wraps goes.",
}


def _items(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _data(node: dict[str, Any] | None) -> dict[str, Any]:
    data = node.get("data") if node else None
    return data if isinstance(data, dict) else {}


def scene_layout_problem(scene: Any) -> str | None:
    """What stops this scene being a layout (``render``, ``app``, ``yield``), None when nothing does."""
    scene = scene if isinstance(scene, dict) else {}
    nodes = _items(scene.get("nodes"))
    edges = _items(scene.get("edges"))

    def flow_from(node_id: Any) -> list[dict[str, Any]]:
        return [edge for edge in edges if edge.get("source") == node_id and edge.get("sourceHandle") == "next"]

    def node_by_id(node_id: Any) -> dict[str, Any] | None:
        return next((node for node in nodes if node.get("id") == node_id), None)

    renders = [node for node in nodes if node.get("type") == "event" and _data(node).get("keyword") == "render"]
    if len(renders) != 1:
        return "render"
    flow = flow_from(renders[0].get("id"))
    draw = node_by_id(flow[0].get("target")) if len(flow) == 1 else None
    if not draw or draw.get("type") != "app" or _data(draw).get("keyword") != "render/image" or flow_from(draw.get("id")):
        return "render"
    feed = next(
        (edge for edge in edges if edge.get("target") == draw.get("id") and edge.get("targetHandle") == "fieldInput/image"),
        None,
    )
    app = node_by_id(feed.get("source")) if feed else None
    if not app or app.get("type") != "app":
        return "app"
    sources = _data(app).get("sources")
    if not isinstance(sources, dict):
        apps = scene.get("apps")
        entry = apps.get(_data(app).get("keyword")) if isinstance(apps, dict) else None
        sources = entry.get("sources") if isinstance(entry, dict) else None
    if not isinstance(sources, dict):
        return "app"
    jsx = [source for name, source in sources.items() if _JSX_FILE.search(str(name)) and isinstance(source, str)]
    if not jsx:
        return "app"
    return None if any(_YIELD_TAG.search(source) for source in jsx) else "yield"


def scene_layout_problem_text(scene: Any) -> str | None:
    """scene_layout_problem in words, for an error message."""
    problem = scene_layout_problem(scene)
    return _PROBLEM_TEXT[problem] if problem else None


def bad_layouts_message(scenes: Any) -> str | None:
    """What is wrong with the scenes marked as layouts, None when nothing is."""
    for scene in _items(scenes):
        settings = scene.get("settings")
        if isinstance(settings, dict) and settings.get("isLayout"):
            text = scene_layout_problem_text(scene)
            if text:
                return f"Scene '{scene.get('name') or scene.get('id')}' can't be a layout: {text}"
    return None
