"""account backup key for end-to-end encrypted cloud backups

The X25519 private key (Fernet-encrypted at rest) seals every backup payload
before upload; the provider only ever stores ciphertext. Generated lazily on
first backup; the user keeps the recovery code in their password manager.

Revision ID: c8d5e2f7a1b9
Revises: a9d2c1e4f6b3
Create Date: 2026-08-02 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "c8d5e2f7a1b9"
down_revision = "a9d2c1e4f6b3"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.add_column(sa.Column("backup_private_key", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("backup_key_fingerprint", sa.String(length=16), nullable=True))


def downgrade():
    with op.batch_alter_table("cloud_backend_link") as batch_op:
        batch_op.drop_column("backup_key_fingerprint")
        batch_op.drop_column("backup_private_key")
