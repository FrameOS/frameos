"""add scenes

Revision ID: a7732707b688
Revises: dd3763041b0f
Create Date: 2023-08-27 00:17:49.527864

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'a7732707b688'
down_revision = 'dd3763041b0f'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('scenes', sqlite.JSON(), nullable=True))

    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('scenes')

    # ### end Alembic commands ###