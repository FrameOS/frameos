"""HyperPixel 2.1 Round: one device id, one driver

Revision ID: 2da906c8e99b
Revises: c9e1f3a5b7d9
Create Date: 2026-09-12 12:00:00.000000

The "(native)" device id `pimoroni.hyperpixel2r_native` is retired: the
native driver is now what `pimoroni.hyperpixel2r` means, and the kernel
overlay "legacy fb" driver is gone. A frame row still carrying the retired
id would select no driver at all, so it is folded into the one id.
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '2da906c8e99b'
down_revision = 'c9e1f3a5b7d9'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("UPDATE frame SET device = 'pimoroni.hyperpixel2r' WHERE device = 'pimoroni.hyperpixel2r_native'")


def downgrade():
    # The retired id cannot be told apart from frames that always used the
    # one id; there is nothing to restore.
    pass
