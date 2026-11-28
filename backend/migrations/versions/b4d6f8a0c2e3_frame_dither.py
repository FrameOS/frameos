"""Frame dither setting

Revision ID: b4d6f8a0c2e3
Revises: d1b5e7a9c3f2
Create Date: 2026-11-22

How the control plane dithers a frame's picture when it packs it for the
panel (thin clients, server rendering): NULL = Floyd-Steinberg as before, or
{"method": "opendisplay", ...} (app/utils/panel_dither.py).
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b4d6f8a0c2e3'
down_revision = 'd1b5e7a9c3f2'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('dither', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('dither')
