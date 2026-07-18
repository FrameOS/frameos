"""cloud link account fields

Revision ID: e3a1b5c7d9f2
Revises: c7e1a9f3d2b4
Create Date: 2026-07-09 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "e3a1b5c7d9f2"
down_revision = "c7e1a9f3d2b4"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.add_column(sa.Column("cloud_account_id", sa.String(length=128), nullable=True))
        batch_op.add_column(sa.Column("cloud_account_email", sa.String(length=256), nullable=True))


def downgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.drop_column("cloud_account_email")
        batch_op.drop_column("cloud_account_id")
