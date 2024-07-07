"""save assets

Revision ID: 701d50ac6812
Revises: 5f067d58955e
Create Date: 2024-07-08 00:01:39.622704

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = '701d50ac6812'
down_revision = '5f067d58955e'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('save_assets', sqlite.JSON(), nullable=True))

    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('save_assets')

    # ### end Alembic commands ###
