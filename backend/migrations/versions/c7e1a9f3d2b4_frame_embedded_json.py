"""add frame embedded config

Revision ID: c7e1a9f3d2b4
Revises: 961ada4af571
Create Date: 2026-06-13 00:00:00.000000

"""

from alembic import op
from sqlalchemy.dialects import sqlite
import sqlalchemy as sa


revision = "c7e1a9f3d2b4"
down_revision = "961ada4af571"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("frame", sa.Column("embedded", sqlite.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("frame", "embedded")
