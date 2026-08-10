"""Cache the cloud account's storage usage + quota snapshot on the link

The provider's grants response now carries a `usage` block (private scene
bytes vs quota, backups, frame logs — public scenes are free). The 15-minute
sync stores it here so the cloud settings section can show quota headroom
without an extra round trip to the provider.

Revision ID: e7a3b9c4d2f6
Revises: d3f1a75c92e4
"""
import sqlalchemy as sa
from alembic import op

revision = "e7a3b9c4d2f6"
down_revision = "d3f1a75c92e4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("cloud_backend_link", sa.Column("cloud_usage", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("cloud_backend_link", "cloud_usage")
