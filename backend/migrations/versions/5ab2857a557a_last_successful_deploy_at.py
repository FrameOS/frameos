"""last successful deploy at

Revision ID: 5ab2857a557a
Revises: 6869aebf00e6
Create Date: 2025-01-01 19:47:03.955629

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5ab2857a557a'
down_revision = '6869aebf00e6'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.add_column('frame', sa.Column('last_successful_deploy_at', sa.DateTime(), nullable=True))
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_column('frame', 'last_successful_deploy_at')
    # ### end Alembic commands ###
