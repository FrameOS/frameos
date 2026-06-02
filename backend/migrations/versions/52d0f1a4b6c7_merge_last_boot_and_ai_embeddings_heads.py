"""merge last boot and ai embeddings heads

Revision ID: 52d0f1a4b6c7
Revises: 34bd721f9e67, a1f2c3d4e5f6
Create Date: 2026-06-02 00:00:00.000000
"""

from typing import Sequence, Union


revision: str = "52d0f1a4b6c7"
down_revision: Union[str, tuple[str, str], None] = ("34bd721f9e67", "a1f2c3d4e5f6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
