"""frame colors

Revision ID: c3d8e1f5a7b2
Revises: b7c2d4e6f8a1
Create Date: 2026-10-10 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'c3d8e1f5a7b2'
down_revision = 'b7c2d4e6f8a1'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('frame', sa.Column('colors', sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column('frame', 'colors')
