"""frame deploy progress

Revision ID: b3c7d9e1f2a4
Revises: e7a1c9d3f5b2
Create Date: 2026-10-12 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b3c7d9e1f2a4'
down_revision = 'e7a1c9d3f5b2'
branch_labels = None
depends_on = None


def upgrade():
    # How far the frame's current deploy / update / restart has come, from
    # the click to the first render (docs/deploy-progress-contract.json;
    # app/utils/deploy_progress.py). The cloud keeps the same row, so the
    # shared workspace draws one progress bar on both control planes.
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('deploy_progress', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('deploy_progress')
