"""local on/off switches for cloud scene + frame backups

The backup scopes are included with every cloud account, but backups must not
upload anything until the user explicitly enables the feature.

Revision ID: a9d2c1e4f6b3
Revises: f2c4d6e8a0b1
Create Date: 2026-07-15 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "a9d2c1e4f6b3"
down_revision = "f2c4d6e8a0b1"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.add_column(
            sa.Column("backup_scenes_enabled", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("backup_frames_enabled", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.drop_column("backup_frames_enabled")
        batch_op.drop_column("backup_scenes_enabled")
