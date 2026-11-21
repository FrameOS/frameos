"""frames: install FrameOS updates automatically

Revision ID: d7e9f1a3b5c8
Revises: a3c5e7f9b1d2
Create Date: 2026-11-20 12:00:00.000000

frame.json `autoUpdate` (docs/auto-updates.md): the frame installs updates by
itself, in the stages docs/update-manifest.json sets. On for every existing
frame, as for a new one; the owner turns it off in Settings.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd7e9f1a3b5c8'
down_revision = 'a3c5e7f9b1d2'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.add_column(sa.Column('auto_update', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))


def downgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.drop_column('auto_update')
