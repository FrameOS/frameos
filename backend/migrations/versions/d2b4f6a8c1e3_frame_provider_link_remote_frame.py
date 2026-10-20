"""provider link: the frame's id in the provider sidecar

Revision ID: d2b4f6a8c1e3
Revises: c7e1a9d4b2f6
Create Date: 2026-10-20 13:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd2b4f6a8c1e3'
down_revision = 'c7e1a9d4b2f6'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame_provider_link', schema=None) as batch_op:
        batch_op.add_column(sa.Column('remote_frame_id', sa.String(length=36), nullable=True))
        batch_op.create_index('ix_frame_provider_link_remote_frame_id', ['remote_frame_id'], unique=True)


def downgrade():
    with op.batch_alter_table('frame_provider_link', schema=None) as batch_op:
        batch_op.drop_index('ix_frame_provider_link_remote_frame_id')
        batch_op.drop_column('remote_frame_id')
