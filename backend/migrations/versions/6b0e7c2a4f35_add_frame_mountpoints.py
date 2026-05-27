"""add frame mountpoints

Revision ID: 6b0e7c2a4f35
Revises: bda2f9e7c0c4
Create Date: 2026-05-27 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite


# revision identifiers, used by Alembic.
revision = "6b0e7c2a4f35"
down_revision = "bda2f9e7c0c4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("frame", sa.Column("mountpoints", sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column("frame", "mountpoints")
