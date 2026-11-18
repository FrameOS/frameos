"""Drop the frame's background color

Revision ID: f2a6c8e0b4d1
Revises: e7c3a9d5f1b4
Create Date: 2026-11-18

The frame-level background color was a leftover from before scenes had their
own `settings.backgroundColor`: no runtime, firmware or control plane read it.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f2a6c8e0b4d1'
down_revision = 'e7c3a9d5f1b4'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('background_color')


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('background_color', sa.String(length=64), nullable=True))
