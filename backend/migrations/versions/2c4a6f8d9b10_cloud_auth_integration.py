"""cloud auth integration

Revision ID: 2c4a6f8d9b10
Revises: b4c8d2e6f901
Create Date: 2026-06-07 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "2c4a6f8d9b10"
down_revision = "b4c8d2e6f901"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cloud_identity",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("provider_url", sa.String(length=512), nullable=False),
        sa.Column("provider_issuer", sa.String(length=512), nullable=False),
        sa.Column("provider_subject", sa.String(length=512), nullable=False),
        sa.Column("cloud_account_id", sa.String(length=128), nullable=True),
        sa.Column("email", sa.String(length=256), nullable=True),
        sa.Column("email_verified", sa.Boolean(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=True),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_issuer", "provider_subject", name="uq_cloud_identity_provider_subject"),
    )
    op.create_index("ix_cloud_identity_user_id", "cloud_identity", ["user_id"])
    op.create_index("ix_cloud_identity_cloud_account_id", "cloud_identity", ["cloud_account_id"])

    op.create_table(
        "cloud_backend_link",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("provider_url", sa.String(length=512), nullable=False),
        sa.Column("provider_issuer", sa.String(length=512), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("public_display_name", sa.String(length=256), nullable=True),
        sa.Column("local_origin", sa.String(length=512), nullable=True),
        sa.Column("device_code", sa.String(length=2048), nullable=True),
        sa.Column("user_code", sa.String(length=64), nullable=True),
        sa.Column("verification_uri", sa.String(length=1024), nullable=True),
        sa.Column("verification_uri_complete", sa.String(length=1024), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("interval_seconds", sa.Integer(), nullable=False),
        sa.Column("poll_error", sa.String(length=128), nullable=True),
        sa.Column("access_token", sa.String(length=4096), nullable=True),
        sa.Column("token_reference", sa.String(length=256), nullable=True),
        sa.Column("linked_client_id", sa.String(length=128), nullable=True),
        sa.Column("cloud_organization_id", sa.String(length=128), nullable=True),
        sa.Column("cloud_project_id", sa.String(length=128), nullable=True),
        sa.Column("scope", sa.String(length=1024), nullable=True),
        sa.Column("local_organization_id", sa.Integer(), nullable=True),
        sa.Column("local_project_id", sa.Integer(), nullable=True),
        sa.Column("local_fallback_enabled", sa.Boolean(), nullable=False),
        sa.Column("last_inventory_sync_at", sa.DateTime(), nullable=True),
        sa.Column("last_grant_sync_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["local_organization_id"], ["organization.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["local_project_id"], ["project.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "cloud_membership",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("backend_link_id", sa.Integer(), nullable=False),
        sa.Column("cloud_account_id", sa.String(length=128), nullable=False),
        sa.Column("cloud_organization_id", sa.String(length=128), nullable=False),
        sa.Column("cloud_project_id", sa.String(length=128), nullable=True),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("local_organization_id", sa.Integer(), nullable=True),
        sa.Column("local_project_id", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("synced_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["backend_link_id"], ["cloud_backend_link.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["local_organization_id"], ["organization.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["local_project_id"], ["project.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "backend_link_id",
            "cloud_account_id",
            "cloud_organization_id",
            "cloud_project_id",
            name="uq_cloud_membership_grant",
        ),
    )
    op.create_index("ix_cloud_membership_cloud_account_id", "cloud_membership", ["cloud_account_id"])


def downgrade():
    op.drop_index("ix_cloud_membership_cloud_account_id", table_name="cloud_membership")
    op.drop_table("cloud_membership")
    op.drop_table("cloud_backend_link")
    op.drop_index("ix_cloud_identity_cloud_account_id", table_name="cloud_identity")
    op.drop_index("ix_cloud_identity_user_id", table_name="cloud_identity")
    op.drop_table("cloud_identity")
