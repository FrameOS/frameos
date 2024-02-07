"""frame api key

Revision ID: 7f2a8719a009
Revises: 3145a02fc973
Create Date: 2024-02-04 23:31:37.112323

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '7f2a8719a009'
down_revision = '3145a02fc973'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('frame_access_key', sa.String(length=256), nullable=True))

    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('frame_access_key')

    # ### end Alembic commands ###