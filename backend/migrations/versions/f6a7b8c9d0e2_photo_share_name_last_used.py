"""photo share links: a custom name and when last used

Revision ID: f6a7b8c9d0e2
Revises: e5f6a7b8c9d1
Create Date: 2026-10-14 22:00:00.000000

A folder may have custom-named links next to its general and per-frame ones
(docs/photos.md "Share links"), and every link records when it was last read
through, so the owner can see which are in use.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'f6a7b8c9d0e2'
down_revision = 'e5f6a7b8c9d1'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('photo_share') as batch_op:
        batch_op.add_column(sa.Column('name', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('last_used_at', sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table('photo_share') as batch_op:
        batch_op.drop_column('last_used_at')
        batch_op.drop_column('name')
