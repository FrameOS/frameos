"""set scene execution modes

Revision ID: bda2f9e7c0c4
Revises: 4ed1a6c9b2d3
Create Date: 2026-05-27 00:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite


# revision identifiers, used by Alembic.
revision = "bda2f9e7c0c4"
down_revision = "4ed1a6c9b2d3"
branch_labels = None
depends_on = None


VALID_EXECUTIONS = {"compiled", "interpreted"}


def _has_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _sources_require_compiled(sources: object) -> bool:
    if not isinstance(sources, dict):
        return False
    return _has_text(sources.get("app.nim")) or _has_text(sources.get("config.nim"))


def _scene_requires_compiled(scene: dict) -> bool:
    apps = scene.get("apps") or {}
    if any(
        _sources_require_compiled(app.get("sources"))
        for app in apps.values()
        if isinstance(app, dict)
    ):
        return True

    for node in scene.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if node.get("type") in {"code", "source"}:
            return True
        data = node.get("data")
        if isinstance(data, dict) and _sources_require_compiled(data.get("sources")):
            return True

    return False


def _scene_needs_execution(scene: object) -> bool:
    if not isinstance(scene, dict):
        return False
    settings = scene.get("settings")
    if not isinstance(settings, dict):
        return True
    return settings.get("execution") not in VALID_EXECUTIONS


def _migrate_scenes(scenes: object) -> tuple[object, bool]:
    if not isinstance(scenes, list):
        return scenes, False

    changed = False
    migrated_scenes = []
    for scene in scenes:
        if _scene_needs_execution(scene):
            migrated_scene = dict(scene)
            settings = migrated_scene.get("settings")
            migrated_scene["settings"] = dict(settings) if isinstance(settings, dict) else {}
            migrated_scene["settings"]["execution"] = (
                "compiled" if _scene_requires_compiled(migrated_scene) else "interpreted"
            )
            migrated_scenes.append(migrated_scene)
            changed = True
        else:
            migrated_scenes.append(scene)

    return migrated_scenes, changed


def upgrade():
    connection = op.get_bind()
    meta = sa.MetaData()
    frame_table = sa.Table(
        "frame",
        meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scenes", sqlite.JSON()),
    )

    frames = connection.execute(sa.select(frame_table.c.id, frame_table.c.scenes)).all()
    for frame_id, scenes in frames:
        migrated_scenes, changed = _migrate_scenes(scenes)
        if changed:
            connection.execute(
                frame_table.update()
                .where(frame_table.c.id == frame_id)
                .values(scenes=migrated_scenes)
            )


def downgrade():
    pass
