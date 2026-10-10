"""frame scene states and scene request

Revision ID: d4e9f2a6b8c3
Revises: c3d8e1f5a7b2
Create Date: 2026-10-10 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'd4e9f2a6b8c3'
down_revision = 'c3d8e1f5a7b2'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('frame', sa.Column('scene_states', sqlite.JSON(), nullable=True))
    op.add_column('frame', sa.Column('scene_request', sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column('frame', 'scene_request')
    op.drop_column('frame', 'scene_states')
