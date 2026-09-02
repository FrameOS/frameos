"""frame.ssh_host_key: the SSH server key pinned on first connect

Revision ID: d4e6f8a0b2c4
Revises: c3d5e7f9a1b2
Create Date: 2026-09-03 00:00:00.000000

SSH connections to frames verified no host key at all. From here the key a
frame offers on the first connect is stored on its row and every later
connect refuses any other key (app/utils/ssh_host_keys.py). NULL means
"not recorded yet": existing frames pin whatever they answer with next.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e6f8a0b2c4"
down_revision = "c3d5e7f9a1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("ssh_host_key", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("ssh_host_key")
