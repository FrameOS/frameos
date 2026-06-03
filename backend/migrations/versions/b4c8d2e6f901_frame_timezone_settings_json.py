"""add frame timezone settings

Revision ID: b4c8d2e6f901
Revises: a1f2c3d4e5f6
Create Date: 2026-06-03 20:35:00.000000

"""

from alembic import op
from sqlalchemy.dialects import sqlite
import sqlalchemy as sa


revision = "b4c8d2e6f901"
down_revision = "a1f2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("frame", sa.Column("timezone_settings", sqlite.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("frame", "timezone_settings")
