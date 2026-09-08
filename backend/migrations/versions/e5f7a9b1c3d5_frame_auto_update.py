"""frame.auto_update: the daily self-update channel

Revision ID: e5f7a9b1c3d5
Revises: e1f2a3b4c5d6
Create Date: 2026-09-08 00:00:00.000000

"off", "stable" or "latest"; NULL reads as "stable", the default. On
`stable` a Pi/Buildroot frame's runtime installs the latest signed GitHub
release once it has been the latest for a day (frameos/auto_updater.nim) and
an ESP32 does the same against its control plane's manifest (fos_ota.c);
`latest` installs every release as it lands. Before this column the ESP32
firmware polled unconditionally on backend-managed frames while nothing else
in FrameOS updated itself.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e5f7a9b1c3d5"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("auto_update", sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("auto_update")
