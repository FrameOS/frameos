"""drop ai embeddings

Revision ID: a1f2c3d4e5f6
Revises: a2e4d9f0b8c7
Create Date: 2026-06-02 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import sqlite


revision: str = "a1f2c3d4e5f6"
down_revision: Union[str, None] = "a2e4d9f0b8c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if inspect(bind).has_table("ai_embeddings"):
        op.drop_table("ai_embeddings")


def downgrade() -> None:
    bind = op.get_bind()
    if inspect(bind).has_table("ai_embeddings"):
        return
    op.create_table(
        "ai_embeddings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("embedding", sqlite.JSON(), nullable=False),
        sa.Column("metadata", sqlite.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "source_type", "source_path", name="uq_ai_embeddings_project_source"),
    )
    op.create_index(op.f("ix_ai_embeddings_project_id"), "ai_embeddings", ["project_id"], unique=False)
