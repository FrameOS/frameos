"""add frame image proxy fallback

Revision ID: 5c4d3e2f1a09
Revises: c7e1a9f3d2b4
Create Date: 2026-06-14 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


revision = "5c4d3e2f1a09"
down_revision = "c7e1a9f3d2b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "frame",
        sa.Column("image_proxy_fallback", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("frame", "image_proxy_fallback")
