"""frame device requests

Revision ID: e7a1b3c5d9f2
Revises: d4e9f2a6b8c3
Create Date: 2026-10-10 18:30:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'e7a1b3c5d9f2'
down_revision = 'd4e9f2a6b8c3'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('frame', sa.Column('device_requests', sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column('frame', 'device_requests')
