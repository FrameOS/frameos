"""frame.service_setting_groups — service keys granted to store scenes

Revision ID: e1f2a3b4c5d6
Revises: d4e6f8a0b2c4
Create Date: 2026-09-07 10:00:00.000000

A scene from the public scene store used to receive every service-settings
group its apps declared, the same as a scene the owner wrote. Declaration is
now a request for store scenes; this column holds what the owner granted on
the frame. NULL = nothing granted, which is the safe default for a frame that
never had a store scene — and, for frames that already run one, the owner
re-grants once (the settings panel lists what each store scene asks for).
"""
from alembic import op
import sqlalchemy as sa


revision = 'e1f2a3b4c5d6'
down_revision = 'd4e6f8a0b2c4'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('service_setting_groups', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('service_setting_groups')
