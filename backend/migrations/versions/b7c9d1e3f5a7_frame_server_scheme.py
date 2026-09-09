"""frame.server_scheme: http or https to the backend, stated instead of guessed

Revision ID: b7c9d1e3f5a7
Revises: e1f2a3b4c5d6
Create Date: 2026-09-09 00:00:00.000000

Three things used to derive http-vs-https from the backend port alone (the
runtime's log shipper and FrameOS Remote: "ends in 443"; ESP32 provisioning:
"is 443"), so an HTTPS backend on 8443 was provisioned as http:// on the
ESP32 and a TLS backend on any other port was talked to in clear. The scheme
is now a column, seeded once from the port the way the old heuristics read
it, and every plane reads the column.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "b7c9d1e3f5a7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("server_scheme", sa.String(8), nullable=True))
    op.execute(
        "UPDATE frame SET server_scheme = CASE WHEN server_port = 443 THEN 'https' ELSE 'http' END "
        "WHERE server_scheme IS NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("server_scheme")
