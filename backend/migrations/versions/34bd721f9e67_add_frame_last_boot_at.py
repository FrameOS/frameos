"""add frame last boot at

Revision ID: 34bd721f9e67
Revises: 9d2f1a3b4c5d
Create Date: 2026-06-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "34bd721f9e67"
down_revision: Union[str, None] = "9d2f1a3b4c5d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("frame", schema=None) as batch_op:
        batch_op.add_column(sa.Column("last_boot_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("frame", schema=None) as batch_op:
        batch_op.drop_column("last_boot_at")
