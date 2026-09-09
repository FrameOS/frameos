"""Column widths that only ever worked on SQLite

Revision ID: c9e1f3a5b7d9
Revises: b7c9d1e3f5a7
Create Date: 2026-09-09 12:00:00.000000

SQLite ignores VARCHAR lengths, so these limits were never enforced where
the backend has always run. PostgreSQL enforces them, and several were
narrower than what the code stores:

* ``user.password`` was String(128) against werkzeug's scrypt hash, which
  is 162 characters — every account creation would fail.
* ``user.email`` was String(120); an address may be 254 characters.
* ``frame.version`` was String(50); the runtime reports
  ``2026.9.12+<40-hex-sha>`` (51 characters).
* ``frame.ssh_pass`` (String(50)) is whatever the user typed;
  ``frame.log_to_file`` and ``frame.assets_path`` (String(256)) are
  filesystem paths; ``cloud_backend_link.access_token`` (String(4096)) is a
  Fernet-encrypted provider token whose size the provider decides. None of
  these has a length by design, so they become Text.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c9e1f3a5b7d9"
down_revision = "b7c9d1e3f5a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("user") as batch_op:
        batch_op.alter_column("email", existing_type=sa.String(120), type_=sa.String(320), existing_nullable=True)
        batch_op.alter_column("password", existing_type=sa.String(128), type_=sa.Text(), existing_nullable=True)
    with op.batch_alter_table("frame") as batch_op:
        batch_op.alter_column("ssh_pass", existing_type=sa.String(50), type_=sa.Text(), existing_nullable=True)
        batch_op.alter_column("version", existing_type=sa.String(50), type_=sa.String(128), existing_nullable=True)
        batch_op.alter_column("log_to_file", existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True)
        batch_op.alter_column("assets_path", existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True)
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.alter_column(
            "access_token", existing_type=sa.String(4096), type_=sa.Text(), existing_nullable=True
        )


def downgrade() -> None:
    # Narrowing back can truncate or fail on rows the wider columns accepted;
    # the widths below are the pre-migration declarations.
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.alter_column(
            "access_token", existing_type=sa.Text(), type_=sa.String(4096), existing_nullable=True
        )
    with op.batch_alter_table("frame") as batch_op:
        batch_op.alter_column("assets_path", existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True)
        batch_op.alter_column("log_to_file", existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True)
        batch_op.alter_column("version", existing_type=sa.String(128), type_=sa.String(50), existing_nullable=True)
        batch_op.alter_column("ssh_pass", existing_type=sa.Text(), type_=sa.String(50), existing_nullable=True)
    with op.batch_alter_table("user") as batch_op:
        batch_op.alter_column("password", existing_type=sa.Text(), type_=sa.String(128), existing_nullable=True)
        batch_op.alter_column("email", existing_type=sa.String(320), type_=sa.String(120), existing_nullable=True)
