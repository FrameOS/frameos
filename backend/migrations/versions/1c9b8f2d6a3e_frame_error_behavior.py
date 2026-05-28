"""frame error behavior

Revision ID: 1c9b8f2d6a3e
Revises: 6b0e7c2a4f35
Create Date: 2026-05-28 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite


# revision identifiers, used by Alembic.
revision = "1c9b8f2d6a3e"
down_revision = "6b0e7c2a4f35"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("frame", sa.Column("error_behavior", sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column("frame", "error_behavior")
