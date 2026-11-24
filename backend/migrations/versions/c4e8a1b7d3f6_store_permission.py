"""Write "store" into the config.json `permissions` of apps that call frameos.storeAction

Revision ID: c4e8a1b7d3f6
Revises: a3c5e7f9b1d2
Create Date: 2026-11-24

From FrameOS 2026.11.15 `frameos.storeAction` (installing, previewing,
updating and removing the frame's scenes, choosing its layout) is for an app
whose config.json `permissions` ask for "store"
(frameos/src/frameos/js_runtime/app_runtime.nim `storeGrant`,
docs/scene-store.md). The editor writes the list from the code on every save
(withAppPermissions in frontend/src/utils/sceneAccess.ts); this does it once
for what is already stored, so a Scene store that was installed before the
permission existed keeps installing: frames, their deploy baseline (so the
deploy drawer does not report a change nobody made) and saved templates.

Only a JavaScript app whose code calls `frameos.storeAction(` and whose list
does not name "store" is touched: a list gains the name, an app with no list
gets one naming it. A config.json that is not strict JSON is left alone (a
frame gives such an app nothing: app/utils/app_config.py). A frame older
than 2026.11.15 ignores the name, so nothing needs redeploying; a frame gets
it with the deploy that installs the release that asks for it, and a board
that pulls its scenes gets it at its next pull.

The detection is a frozen copy of the editor's as of this revision, kept here
rather than imported so that later changes to it cannot change what this
migration did.
"""
from __future__ import annotations

import copy
import json
import re

import sqlalchemy as sa
from alembic import op

revision = "c4e8a1b7d3f6"
down_revision = "a3c5e7f9b1d2"
branch_labels = None
depends_on = None

_MAIN_FILES = ("app.ts", "app.js", "app.tsx", "app.jsx")
_JS_FILE = re.compile(r"\.(tsx?|jsx?|mjs|cjs)$")
_STORE_CALL = re.compile(r"\bframeos\s*\.\s*storeAction\s*\(")
_INDENT = re.compile(r'\n( +)"')
_MAX_DEPTH = 32


def _refuse_constant(name: str):
    raise ValueError(name)


def _within_depth(value, depth: int) -> bool:
    if not isinstance(value, (dict, list)):
        return True
    if depth <= 0:
        return False
    return all(_within_depth(item, depth - 1) for item in (value.values() if isinstance(value, dict) else value))


def _calls_store(sources: dict[str, str]) -> bool:
    return any(_JS_FILE.search(name) and _STORE_CALL.search(text) for name, text in sources.items())


def _config_with_store(text):
    """config.json with "store" in its `permissions`, or None to leave it as
    it is. Other keys keep their order; a new list goes after `settings`, or
    last; the file keeps its indent and trailing newline. An app with no
    config.json gets one."""
    if text is None:
        return json.dumps({"permissions": ["store"]}, indent=2) + "\n"
    try:
        config = json.loads(text, parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        return None
    if not isinstance(config, dict) or not _within_depth(config, _MAX_DEPTH):
        return None
    listed = config.get("permissions")
    if "permissions" in config:
        if not isinstance(listed, list) or "store" in listed:
            return None
        config["permissions"] = [*listed, "store"]
        entries = list(config.items())
    else:
        entries = list(config.items())
        settings_at = next((index for index, (key, _) in enumerate(entries) if key == "settings"), None)
        entries.insert(len(entries) if settings_at is None else settings_at + 1, ("permissions", ["store"]))
    indent_match = _INDENT.search(text)
    indent = len(indent_match.group(1)) if indent_match else 2
    return json.dumps(dict(entries), indent=indent, ensure_ascii=False) + ("\n" if text.endswith("\n") else "")


def _sources_with_store(sources):
    """The app's sources with "store" asked for, or None when unchanged. Only
    JavaScript apps that call the store: a frame asks no other app for it."""
    if not isinstance(sources, dict):
        return None
    strings = {name: text for name, text in sources.items() if isinstance(text, str)}
    if not any(strings.get(name, "").strip() for name in _MAIN_FILES) or not _calls_store(strings):
        return None
    if "config.json" in sources and not isinstance(sources["config.json"], str):
        return None
    updated = _config_with_store(strings.get("config.json"))
    return None if updated is None else {**sources, "config.json": updated}


def _stamp_scene(scene) -> bool:
    """Ask for "store" where `scene`'s apps call it, in place; True when
    anything changed: the scene's own apps (`apps`) and apps edited inline on
    a node."""
    if not isinstance(scene, dict):
        return False
    changed = False
    apps = scene.get("apps")
    if isinstance(apps, dict):
        for keyword, app in list(apps.items()):
            if isinstance(app, dict):
                sources = _sources_with_store(app.get("sources"))
                if sources is not None:
                    apps[keyword] = {**app, "sources": sources}
                    changed = True
    nodes = scene.get("nodes")
    if isinstance(nodes, list):
        for index, node in enumerate(nodes):
            data = node.get("data") if isinstance(node, dict) and node.get("type") == "app" else None
            if isinstance(data, dict):
                sources = _sources_with_store(data.get("sources"))
                if sources is not None:
                    nodes[index] = {**node, "data": {**data, "sources": sources}}
                    changed = True
    return changed


def _stamped(scenes):
    """A copy of `scenes` with "store" asked for where it is called, or None
    when nothing changed."""
    if not isinstance(scenes, list):
        return None
    copied = copy.deepcopy(scenes)
    changed = False
    for scene in copied:
        changed = _stamp_scene(scene) or changed
    return copied if changed else None


def _stamp_frames(connection) -> None:
    table = sa.Table(
        "frame",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scenes", sa.JSON()),
        sa.Column("last_successful_deploy", sa.JSON()),
    )
    rows = connection.execute(sa.select(table.c.id, table.c.scenes, table.c.last_successful_deploy)).all()
    for row_id, scenes, baseline in rows:
        values = {}
        stamped = _stamped(scenes)
        if stamped is not None:
            values["scenes"] = stamped
        if isinstance(baseline, dict):
            baseline_scenes = _stamped(baseline.get("scenes"))
            if baseline_scenes is not None:
                values["last_successful_deploy"] = {**baseline, "scenes": baseline_scenes}
        if values:
            connection.execute(table.update().where(table.c.id == row_id).values(**values))


def _stamp_templates(connection) -> None:
    table = sa.Table(
        "template",
        sa.MetaData(),
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("scenes", sa.JSON()),
    )
    rows = connection.execute(sa.select(table.c.id, table.c.scenes)).all()
    for row_id, scenes in rows:
        stamped = _stamped(scenes)
        if stamped is not None:
            connection.execute(table.update().where(table.c.id == row_id).values(scenes=stamped))


def upgrade():
    connection = op.get_bind()
    _stamp_frames(connection)
    _stamp_templates(connection)


def downgrade():
    # The name is inert to a backend (and a frame) that predates it.
    pass
