"""add frame image engine

Revision ID: 53a8f0c9d1b2
Revises: 2a7c4e9b8f01
Create Date: 2026-06-01 09:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "53a8f0c9d1b2"
down_revision = "2a7c4e9b8f01"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("frame", sa.Column("image_engine", sa.String(length=32), nullable=True))


def downgrade():
    op.drop_column("frame", "image_engine")
