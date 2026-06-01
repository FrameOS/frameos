"""add max http response bytes

Revision ID: 8b3d7a41c9e2
Revises: 53a8f0c9d1b2
Create Date: 2026-06-01 12:35:00.000000

"""

from alembic import op
import sqlalchemy as sa


revision = "8b3d7a41c9e2"
down_revision = "53a8f0c9d1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "frame",
        sa.Column("max_http_response_bytes", sa.Integer(), nullable=True, server_default=str(64 * 1024 * 1024)),
    )


def downgrade() -> None:
    op.drop_column("frame", "max_http_response_bytes")
