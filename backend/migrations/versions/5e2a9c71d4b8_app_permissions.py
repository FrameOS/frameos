"""Write each JavaScript app's config.json `permissions` from its code

Revision ID: 5e2a9c71d4b8
Revises: f6a7b8c9d0e2
Create Date: 2026-10-17

From FrameOS 2026.10.16 a frame gives a JavaScript app exactly what its
config.json `permissions` list asks for, and an app with no list gets nothing
(docs/scene-guide.md "Assets", JsAssetGrant in
frameos/src/frameos/js_runtime/app_runtime.nim). The editor writes the list on
every save (withAppPermissions in frontend/src/utils/sceneAccess.ts); this
does the same, once, for every scene already stored: frames, their deploy
baseline (so the deploy drawer does not report a change nobody made) and
saved templates. A scene saved before the lists existed keeps doing what it
did: these are scenes the owner already runs, so what the code reaches for is
granted.

Only apps with no list get one, the way the cloud stamps the store scenes it
reads (`onlyMissing`): a list already there and a config.json that does not
parse are left alone. A frame older than 2026.10.16 ignores the key, so nothing needs
redeploying; a frame gets the lists with the deploy that installs the release
that reads them.

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

revision = "5e2a9c71d4b8"
down_revision = "f6a7b8c9d0e2"
branch_labels = None
depends_on = None

_PERMISSIONS = ("shell", "files", "assets", "assets-write")
_MAIN_FILES = ("app.ts", "app.js", "app.tsx", "app.jsx")
_JS_FILE = re.compile(r"\.(tsx?|jsx?|mjs|cjs)$")
_NIM_SHELL = re.compile(
    r"\b(execShellCmd|execCmdEx|execCmd|execProcess|startProcess|runShellWithParentStreams|runShellCapture|osproc|quoteShell)\b"
)
_READ_CALL = re.compile(r"\b(listAssets|assetExists|assetSize|readAsset|loadAssetImage)\b")
_WRITE_CALL = re.compile(r"\b(writeAsset|appendAsset|deleteAsset)\b")
_STREAM_CALL = re.compile(r"\bopenAssetStream\b")
# A literal stream mode: 'r', "r" or `r` (escaped to \"r\" inside JSON text).
_LITERAL_MODE = re.compile(r"""^\\?(["'`])([rwa])\\?\1$""")
_INDENT = re.compile(r'\n( +)"')


def _stream_writes(text: str, start: int) -> bool:
    """Whether the openAssetStream(...) call starting at `start` opens for
    writing: mode "w" or "a", or a mode that is not a literal. No mode is "r"."""
    index = start
    while index < len(text) and text[index].isspace():
        index += 1
    if index >= len(text) or text[index] != "(":
        return False
    depth = 0
    args = [""]
    index += 1
    while index < len(text):
        char = text[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif char == "," and depth == 0:
            args.append("")
            index += 1
            continue
        args[-1] += char
        index += 1
    mode = args[1].strip() if len(args) > 1 else ""
    if not mode:
        return False
    literal = _LITERAL_MODE.match(mode)
    return literal is None or literal.group(2) != "r"


def _detect(sources: dict[str, str]) -> list[str]:
    """What an app's own files reach for: asset calls in its JavaScript,
    process APIs in a legacy Nim file."""
    reads = writes = shell = False
    for name, text in sources.items():
        if name.endswith(".nim"):
            shell = shell or bool(_NIM_SHELL.search(text))
            continue
        if not _JS_FILE.search(name):
            continue
        reads = reads or bool(_READ_CALL.search(text))
        writes = writes or bool(_WRITE_CALL.search(text))
        for match in _STREAM_CALL.finditer(text):
            if _stream_writes(text, match.end()):
                writes = True
            else:
                reads = True
    found = set()
    if shell:
        found.add("shell")
    if reads or writes:
        found.add("assets")
    if writes:
        found.add("assets-write")
    return [permission for permission in _PERMISSIONS if permission in found]


def _config_with_permissions(text, permissions: list[str]):
    """config.json with `permissions` added, or None to leave it as it is.
    Other keys keep their order; the list goes after `settings`, or last; the
    file keeps its indent and trailing newline. An app with no config.json
    gets one."""
    if text is None:
        return json.dumps({"permissions": permissions}, indent=2) + "\n"
    try:
        config = json.loads(text)
    except ValueError:
        return None
    if not isinstance(config, dict) or "permissions" in config:
        return None
    entries = list(config.items())
    settings_at = next((index for index, (key, _) in enumerate(entries) if key == "settings"), None)
    entries.insert(len(entries) if settings_at is None else settings_at + 1, ("permissions", permissions))
    indent_match = _INDENT.search(text)
    indent = len(indent_match.group(1)) if indent_match else 2
    return json.dumps(dict(entries), indent=indent, ensure_ascii=False) + ("\n" if text.endswith("\n") else "")


def _sources_with_permissions(sources):
    """The app's sources with config.json filled in, or None when unchanged.
    Only JavaScript apps: a frame enforces no list for anything else."""
    if not isinstance(sources, dict):
        return None
    strings = {name: text for name, text in sources.items() if isinstance(text, str)}
    if not any(strings.get(name, "").strip() for name in _MAIN_FILES):
        return None
    updated = _config_with_permissions(strings.get("config.json"), _detect(strings))
    return None if updated is None else {**sources, "config.json": updated}


def _stamp_scene(scene) -> bool:
    """Fill in the lists of `scene`'s apps in place; True when anything changed:
    the scene's own apps (`apps`) and apps edited inline on a node."""
    if not isinstance(scene, dict):
        return False
    changed = False
    apps = scene.get("apps")
    if isinstance(apps, dict):
        for keyword, app in list(apps.items()):
            if isinstance(app, dict):
                sources = _sources_with_permissions(app.get("sources"))
                if sources is not None:
                    apps[keyword] = {**app, "sources": sources}
                    changed = True
    nodes = scene.get("nodes")
    if isinstance(nodes, list):
        for index, node in enumerate(nodes):
            data = node.get("data") if isinstance(node, dict) and node.get("type") == "app" else None
            if isinstance(data, dict):
                sources = _sources_with_permissions(data.get("sources"))
                if sources is not None:
                    nodes[index] = {**node, "data": {**data, "sources": sources}}
                    changed = True
    return changed


def _stamped(scenes):
    """A copy of `scenes` with every app's list filled in, or None when nothing changed."""
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
    # The lists are inert to a backend (and a frame) that predates them.
    pass
