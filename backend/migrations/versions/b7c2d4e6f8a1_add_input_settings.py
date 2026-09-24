"""add input settings

Revision ID: b7c2d4e6f8a1
Revises: 2da906c8e99b
Create Date: 2026-09-23 12:00:00.000000

frame.json `inputSettings` (keyboard layout, grab keyboard): a JSON object
column like error_behavior; NULL means the runtime's defaults ("us", true).
"""

from alembic import op
import sqlalchemy as sa


revision = "b7c2d4e6f8a1"
down_revision = "2da906c8e99b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("frame", sa.Column("input_settings", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("frame", "input_settings")
