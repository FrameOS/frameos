"""frames: whether the settings on the frame's screen offer the frame page

Revision ID: b8d4e1f6a2c3
Revises: e7a3c9d2f5b1
Create Date: 2026-11-08 12:00:00.000000

frame.json `frameSettingsOnScreen` (docs/scene-settings.md "The frame page"):
the settings panel on the frame's own screen offers the frame page behind its
gear (Wi-Fi, rotation, scale, Restart, Reboot). On for every existing frame,
as for a new one.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b8d4e1f6a2c3'
down_revision = 'e7a3c9d2f5b1'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.add_column(sa.Column('frame_settings_on_screen', sa.Boolean(), nullable=False,
                                      server_default=sa.true()))


def downgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.drop_column('frame_settings_on_screen')
