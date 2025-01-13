"""upload fonts

Revision ID: 91f9db3712b9
Revises: 5ab2857a557a
Create Date: 2025-01-12 22:19:56.689288

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '91f9db3712b9'
down_revision = '5ab2857a557a'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.add_column('frame', sa.Column('upload_fonts', sa.String(length=10), nullable=True))
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_column('frame', 'upload_fonts')
    # ### end Alembic commands ###