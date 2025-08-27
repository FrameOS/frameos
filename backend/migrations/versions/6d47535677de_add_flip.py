"""add flip column

Revision ID: 6d47535677de
Revises: 2656e03eee76
Create Date: 2025-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '6d47535677de'
down_revision = '2656e03eee76'
branch_labels = None
depends_on = None

def upgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('flip', sa.String(length=32), nullable=True))

def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('flip')
