"""photo share links per frame

Revision ID: e5f6a7b8c9d1
Revises: d4e8f1a2b3c5
Create Date: 2026-10-14 21:30:00.000000

A folder may have a share link per frame it plays on (docs/photos.md "Share
links"), so one frame's access can be withdrawn without touching the others.
`frame_id` is NULL for the folder's general link, as every existing row is.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'e5f6a7b8c9d1'
down_revision = 'd4e8f1a2b3c5'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('photo_share') as batch_op:
        batch_op.add_column(sa.Column('frame_id', sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table('photo_share') as batch_op:
        batch_op.drop_column('frame_id')
