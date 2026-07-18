"""track the deploy timestamp successfully backed up to cloud

Revision ID: f2c4d6e8a0b1
Revises: e3a1b5c7d9f2
Create Date: 2026-07-14 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "f2c4d6e8a0b1"
down_revision = "e3a1b5c7d9f2"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("last_cloud_backup_deploy_at", sa.DateTime(), nullable=True))

    # Existing deploys predate durable success tracking. Treat them as seen so
    # upgrading a worker does not upload every frame at once.
    op.execute(
        "UPDATE frame SET last_cloud_backup_deploy_at = last_successful_deploy_at "
        "WHERE last_successful_deploy_at IS NOT NULL"
    )


def downgrade():
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("last_cloud_backup_deploy_at")
