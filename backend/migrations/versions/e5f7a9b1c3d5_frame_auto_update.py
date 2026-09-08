"""frame.auto_update: the daily self-update switch

Revision ID: e5f7a9b1c3d5
Revises: d4e6f8a0b2c4
Create Date: 2026-09-08 00:00:00.000000

Off (NULL) for every existing frame. When on, a Pi/Buildroot frame's runtime
checks GitHub for a newer signed release once a day and installs it
(frameos/auto_updater.nim); an ESP32 polls its control plane's manifest
(fos_ota.c). Before this column the ESP32 firmware did that unconditionally
on backend-managed frames while nothing else in FrameOS updated itself.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e5f7a9b1c3d5"
down_revision = "d4e6f8a0b2c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("auto_update", sa.Boolean(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("auto_update")
