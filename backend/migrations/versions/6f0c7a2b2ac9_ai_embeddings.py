"""ai_embeddings

Revision ID: 6f0c7a2b2ac9
Revises: 2f3e0b14d75c
Create Date: 2025-02-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = "6f0c7a2b2ac9"
down_revision = "2f3e0b14d75c"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ai_embeddings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("embedding", sqlite.JSON(), nullable=False),
        sa.Column("metadata", sqlite.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_type", "source_path", name="uq_ai_embeddings_source"),
    )


def downgrade():
    op.drop_table("ai_embeddings")
