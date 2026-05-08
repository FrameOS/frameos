"""add server send logs to frame

Revision ID: 8a1c7d9b2e13
Revises: 60acbd298511
Create Date: 2026-03-07 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8a1c7d9b2e13'
down_revision = '60acbd298511'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('server_send_logs', sa.Boolean(), nullable=True, server_default=sa.true()))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('server_send_logs')
