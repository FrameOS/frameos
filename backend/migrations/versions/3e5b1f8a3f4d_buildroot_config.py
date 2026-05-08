"""buildroot config

Revision ID: 3e5b1f8a3f4d
Revises: 6d47535677de
Create Date: 2025-02-14 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite


# revision identifiers, used by Alembic.
revision = '3e5b1f8a3f4d'
down_revision = '6d47535677de'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('frame', sa.Column('buildroot', sqlite.JSON(), nullable=True))


def downgrade():
    op.drop_column('frame', 'buildroot')
