"""Drop the frame's refresh interval

Revision ID: a3c5e7f9b1d2
Revises: f2a6c8e0b4d1
Create Date: 2026-11-18

A frame renders on its scenes' refresh intervals: every scene carries one, a
server-rendered board is told the scene's (X-FrameOS-Next-Render), and a
frame with no opinion from its scene waits 300 s. The frame-level interval
was only a fallback almost nothing reached, and a third place to look for
"how often does the picture change". Devices that still hold one (an ESP32's
NVS, a Pico's stored config, a Pi's frame.json) ignore it.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a3c5e7f9b1d2'
down_revision = 'f2a6c8e0b4d1'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('interval')


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('interval', sa.Double(), nullable=True, server_default='300'))
