"""scene execution: stamp late arrivals and templates, interpreted is the default

Revision ID: c3d5e7f9a1b2
Revises: b7e2d4c6a8f0
Create Date: 2026-08-24 00:00:00.000000

bda2f9e7c0c4 (2026-05) stamped ``settings.execution`` onto every frame scene,
but templates were never stamped and every ingest path since (template
install, import, chat-built scenes, device pulls, backup restores) let
unstamped scenes back in. Readers treated an absent key as *compiled*, so
those scenes quietly forced a source build. From this revision on readers
treat absent as *interpreted*; this pass stamps whatever is still unstamped
so the flip changes nothing for scenes that genuinely need the compiler.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3d5e7f9a1b2"
down_revision = "b7e2d4c6a8f0"
branch_labels = None
depends_on = None


def _stamp_scenes(connection, table_name: str) -> None:
    # The inference of 2026-08, frozen here: a scene that carried Nim the
    # interpreter cannot run was stamped `compiled`, everything else
    # `interpreted`. The ingest paths stopped inferring `compiled` on
    # 2026-08-30 (app/utils/scene_execution.py), but this one-time stamp of
    # data that predates the decision keeps its meaning — a self-hoster
    # upgrading late must not find their compiled scenes silently switched.
    from app.utils.scene_execution import explicit_scene_execution, scene_requires_compilation

    def normalize_scenes_execution(scenes) -> bool:
        if not isinstance(scenes, list):
            return False
        changed = False
        for scene in scenes:
            if not isinstance(scene, dict) or explicit_scene_execution(scene) is not None:
                continue
            settings = scene.get("settings")
            if not isinstance(settings, dict):
                settings = {}
                scene["settings"] = settings
            settings["execution"] = "compiled" if scene_requires_compilation(scene) else "interpreted"
            changed = True
        return changed

    table = sa.Table(
        table_name,
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scenes", sa.JSON()),
    )
    rows = connection.execute(sa.select(table.c.id, table.c.scenes)).all()
    for row_id, scenes in rows:
        if not isinstance(scenes, list):
            continue
        if normalize_scenes_execution(scenes):
            connection.execute(table.update().where(table.c.id == row_id).values(scenes=scenes))


def upgrade():
    connection = op.get_bind()
    _stamp_scenes(connection, "frame")
    _stamp_scenes(connection, "template")


def downgrade():
    pass
