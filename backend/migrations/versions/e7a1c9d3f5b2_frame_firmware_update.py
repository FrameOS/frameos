"""frame firmware update progress

Revision ID: e7a1c9d3f5b2
Revises: d4e5f6a7b8c9
Create Date: 2026-10-12 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'e7a1c9d3f5b2'
down_revision = 'd4e5f6a7b8c9'
branch_labels = None
depends_on = None


def upgrade():
    # What the device last said about its firmware update, folded from its
    # `ota:<plane>` (ESP32) / `cloud:upgrade` (Pi) log lines by
    # app/models/log.py — the same row the cloud keeps in
    # frames.firmware_update, so the shared workspace shows "updating
    # firmware 42%" on both control planes.
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('firmware_update', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('firmware_update')
