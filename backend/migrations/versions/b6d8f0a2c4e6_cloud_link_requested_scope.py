"""Remember which scopes a pending cloud approval asked for

The provider's answer to an approval names the scopes it granted, and the
link took them as given: a provider could answer with more than this install
asked for (cloud login, for one). The request's own scopes are kept beside
the pending device code now, and the answer is cut down to them.

Revision ID: b6d8f0a2c4e6
Revises: a3c5e7f9b1d2
"""
import sqlalchemy as sa
from alembic import op

revision = "b6d8f0a2c4e6"
down_revision = "a3c5e7f9b1d2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("cloud_backend_link", sa.Column("requested_scope", sa.String(length=1024), nullable=True))


def downgrade():
    op.drop_column("cloud_backend_link", "requested_scope")
