"""legacy source build: open the door for frames that already depend on it

Revision ID: d4e6f8a0b2c4
Revises: c3d5e7f9a1b2
Create Date: 2026-08-30 00:00:00.000000

From this revision on a deploy compiles Nim only when the frame carries
``rpios.legacySourceBuild`` / ``buildroot.legacySourceBuild`` = true
(docs/convergence-todo.md, Stage 4). Every frame that would otherwise stop
working — one with a compiled scene, or with an explicit ``static`` (or the
retired ``shared`` / ``shared-scenes``) compilation mode — gets the key set
here so the upgrade changes nothing for it; the editor shows the amber
"legacy" chip to say the door is open. Fresh frames start with it shut.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e6f8a0b2c4"
down_revision = "c3d5e7f9a1b2"
branch_labels = None
depends_on = None

SOURCE_BUILD_MODES = {"static", "shared", "shared-scenes"}


def _needs_source_build(mode: str | None, rpios, buildroot, scenes) -> bool:
    from app.utils.scene_execution import scene_is_interpreted

    settings = buildroot if mode == "buildroot" else rpios
    stored_mode = settings.get("compilationMode") if isinstance(settings, dict) else None
    if isinstance(stored_mode, str) and stored_mode.strip().lower() in SOURCE_BUILD_MODES:
        return True
    if isinstance(scenes, list):
        for scene in scenes:
            if isinstance(scene, dict) and not scene_is_interpreted(scene):
                return True
    return False


def upgrade():
    connection = op.get_bind()
    table = sa.Table(
        "frame",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("mode", sa.String(32)),
        sa.Column("rpios", sa.JSON()),
        sa.Column("buildroot", sa.JSON()),
        sa.Column("scenes", sa.JSON()),
    )
    rows = connection.execute(
        sa.select(table.c.id, table.c.mode, table.c.rpios, table.c.buildroot, table.c.scenes)
    ).all()
    for row_id, mode, rpios, buildroot, scenes in rows:
        if mode == "embedded":
            continue
        if not _needs_source_build(mode, rpios, buildroot, scenes):
            continue
        if mode == "buildroot":
            updated = dict(buildroot) if isinstance(buildroot, dict) else {}
            updated["legacySourceBuild"] = True
            connection.execute(table.update().where(table.c.id == row_id).values(buildroot=updated))
        else:
            updated = dict(rpios) if isinstance(rpios, dict) else {}
            updated["legacySourceBuild"] = True
            connection.execute(table.update().where(table.c.id == row_id).values(rpios=updated))


def downgrade():
    # The key is inert on older code: a frame that never reads it deploys
    # exactly as it did before, so there is nothing to undo.
    pass
