"""add log ip

Revision ID: 2f3e0b14d75c
Revises: 7132985d44a8
Create Date: 2025-01-16 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '2f3e0b14d75c'
down_revision = '7132985d44a8'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('log', schema=None) as batch_op:
        batch_op.add_column(sa.Column('ip', sa.String(length=64), nullable=True))


def downgrade():
    with op.batch_alter_table('log', schema=None) as batch_op:
        batch_op.drop_column('ip')
