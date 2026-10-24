"""frames: the frame's event map (what its buttons do, whatever scene shows)

Revision ID: c4e8a2d7f1b9
Revises: b3d7f1a9c2e5
Create Date: 2026-10-24 12:00:00.000000

frame.json `eventMap` (docs/events.md, "Event map"): a long press of a
reTerminal's LEFT is the previous scene on every scene. NULL is "never set"
(an embedded preset seeds it), [] is "cleared by the owner".

A reTerminal frame that already exists gets its preset's map here: the
firmware of this release runs those bindings whether or not the backend holds
them, and the owner overrides them under Settings > Button actions only if
the backend shows them. Other frames stay NULL.
"""
import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c4e8a2d7f1b9'
down_revision = 'b3d7f1a9c2e5'
branch_labels = None
depends_on = None


PRESET_KEYS = ("hardwarePreset", "hardware_preset", "boardPreset", "board_preset")


def _preset_of(*sources) -> str:
    """The frame's embedded hardware preset, the way embedded_firmware.py reads it."""
    for source in sources:
        if isinstance(source, str):
            try:
                source = json.loads(source)
            except ValueError:
                continue
        if isinstance(source, dict):
            for key in PRESET_KEYS:
                if key in source:
                    return str(source.get(key) or "").strip().replace("-", "_").replace(".", "_").lower()
    return ""


def _seed_reterminal_frames(connection) -> None:
    from app.tasks.embedded_firmware import EMBEDDED_HARDWARE_PRESETS

    table = sa.Table(
        "frame",
        sa.MetaData(),
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("embedded", sa.JSON()),
        sa.Column("device_config", sa.JSON()),
        sa.Column("event_map", sa.JSON()),
    )
    for row in connection.execute(sa.select(table.c.id, table.c.embedded, table.c.device_config)).fetchall():
        preset = EMBEDDED_HARDWARE_PRESETS.get(_preset_of(row.embedded, row.device_config))
        event_map = (preset or {}).get("eventMap")
        if isinstance(event_map, list) and event_map:
            connection.execute(
                table.update().where(table.c.id == row.id).values(event_map=json.loads(json.dumps(event_map)))
            )


def upgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.add_column(sa.Column('event_map', sa.JSON(), nullable=True))
    _seed_reterminal_frames(op.get_bind())


def downgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.drop_column('event_map')
