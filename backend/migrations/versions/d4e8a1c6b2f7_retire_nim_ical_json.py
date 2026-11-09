"""Rewrite the retired Nim app data/icalJson into its JavaScript replacement

Revision ID: d4e8a1c6b2f7
Revises: b8d4e1f6a2c3
Create Date: 2026-11-09

The built-in Nim app data/icalJson was deleted; its replacement is the repo
JavaScript app repo/apps/json/icalJson, carried by each scene in its `apps`
map (docs/retired-apps.md). Every stored scene is rewritten in place: frames,
their deploy baseline (so the deploy drawer does not report a change nobody
made) and saved templates. What a device is SENT still depends on its runtime:
one older than 2026.11.6 gets the Nim keyword back
(app/utils/retired_apps.py), so nothing needs redeploying.
"""
from __future__ import annotations

import copy

import sqlalchemy as sa
from alembic import op

revision = "d4e8a1c6b2f7"
down_revision = "b8d4e1f6a2c3"
branch_labels = None
depends_on = None

KEYWORDS = ["data/icalJson"]


def _retired(scenes):
    """A rewritten copy of `scenes`, or None when nothing changed."""
    from app.utils.retired_apps import retire_apps_in_scenes

    if not isinstance(scenes, list):
        return None
    copied = copy.deepcopy(scenes)
    return copied if retire_apps_in_scenes(copied, KEYWORDS) else None


def _retire_frames(connection) -> None:
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
        retired = _retired(scenes)
        if retired is not None:
            values["scenes"] = retired
        if isinstance(baseline, dict):
            baseline_scenes = _retired(baseline.get("scenes"))
            if baseline_scenes is not None:
                values["last_successful_deploy"] = {**baseline, "scenes": baseline_scenes}
        if values:
            connection.execute(table.update().where(table.c.id == row_id).values(**values))


def _retire_templates(connection) -> None:
    table = sa.Table(
        "template",
        sa.MetaData(),
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("scenes", sa.JSON()),
    )
    rows = connection.execute(sa.select(table.c.id, table.c.scenes)).all()
    for row_id, scenes in rows:
        retired = _retired(scenes)
        if retired is not None:
            connection.execute(table.update().where(table.c.id == row_id).values(scenes=retired))


def upgrade():
    connection = op.get_bind()
    _retire_frames(connection)
    _retire_templates(connection)


def downgrade():
    # A backend downgraded to a release that still has the Nim app runs the
    # rewritten scenes as JavaScript apps, which any runtime with JS apps
    # does, so nothing here tries to undo it.
    pass
