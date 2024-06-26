"""log to file

Revision ID: 1e2acb9652e8
Revises: b29d2204547c
Create Date: 2024-04-26 01:13:40.516170

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '1e2acb9652e8'
down_revision = 'b29d2204547c'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('log_to_file', sa.String(length=256), nullable=True))
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('log_to_file')
    # ### end Alembic commands ###
