"""add archived to frame

Revision ID: 4ed1a6c9b2d3
Revises: 29c824d6b6c3
Create Date: 2026-05-20 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '4ed1a6c9b2d3'
down_revision = '29c824d6b6c3'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('frame', sa.Column('archived', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column('frame', 'archived')
