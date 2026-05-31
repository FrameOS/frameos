"""add frame timezone

Revision ID: 2a7c4e9b8f01
Revises: 1c9b8f2d6a3e
Create Date: 2026-05-31 10:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "2a7c4e9b8f01"
down_revision = "1c9b8f2d6a3e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("frame", sa.Column("timezone", sa.String(length=128), nullable=True))


def downgrade() -> None:
    op.drop_column("frame", "timezone")
