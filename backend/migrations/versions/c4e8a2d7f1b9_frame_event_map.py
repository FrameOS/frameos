"""frames: the frame's event map (what its buttons do, whatever scene shows)

Revision ID: c4e8a2d7f1b9
Revises: b3d7f1a9c2e5
Create Date: 2026-10-24 12:00:00.000000

frame.json `eventMap` (docs/events.md, "Event map"): a long press of a
reTerminal's LEFT is the previous scene on every scene. NULL is "never set"
(an embedded preset seeds it), [] is "cleared by the owner".
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c4e8a2d7f1b9'
down_revision = 'b3d7f1a9c2e5'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.add_column(sa.Column('event_map', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.drop_column('event_map')
