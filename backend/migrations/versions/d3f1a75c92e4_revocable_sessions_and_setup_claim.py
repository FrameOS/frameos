"""Revocable local sessions, and a claim on first-run setup linking

Two findings from docs/cloud-security-review.md:

- Local sessions were self-contained Fernet cookies and JWTs with no
  server-side record, so nothing could end one before its seven days were up —
  not logout, not a password change, not revoking the cloud link. `user_session`
  is the record each credential's `jti` now points at.
- `/api/cloud/setup/*` is open while no user exists, so a LAN attacker could
  pre-link a fresh install to their own cloud account. `setup_claim` binds the
  flow to the browser that started it.

Revision ID: d3f1a75c92e4
Revises: c8d5e2f7a1b9
"""
import sqlalchemy as sa
from alembic import op

revision = "d3f1a75c92e4"
down_revision = "c8d5e2f7a1b9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_session",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("session_id_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id_hash"),
    )
    op.create_index("ix_user_session_user_id", "user_session", ["user_id"])

    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.add_column(sa.Column("setup_claim", sa.String(length=64), nullable=True))


def downgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.drop_column("setup_claim")

    op.drop_index("ix_user_session_user_id", table_name="user_session")
    op.drop_table("user_session")
