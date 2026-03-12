"""add frame admin auth to frame

Revision ID: bf9d1ab93c21
Revises: 8a1c7d9b2e13
Create Date: 2026-03-08 00:00:00.000000

"""
from alembic import op
from sqlalchemy.dialects import sqlite
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'bf9d1ab93c21'
down_revision = '8a1c7d9b2e13'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('frame_admin_auth', sqlite.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('frame_admin_auth')
