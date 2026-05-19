"""cloud auth return url

Revision ID: b6a1e2f9d4c0
Revises: 9d2f4c8a7b31
Create Date: 2026-05-20 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b6a1e2f9d4c0'
down_revision = '9d2f4c8a7b31'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('cloud_auth_session', sa.Column('return_to', sa.String(length=2048), nullable=True))


def downgrade():
    op.drop_column('cloud_auth_session', 'return_to')
