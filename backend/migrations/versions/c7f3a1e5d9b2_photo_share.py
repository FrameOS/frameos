"""photo share links

Revision ID: c7f3a1e5d9b2
Revises: b4d8f2a6c1e9
Create Date: 2026-10-13 12:00:00.000000

Share links for the photo library (docs/photos.md): a token that gives read
access to one folder of a project's photos.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c7f3a1e5d9b2'
down_revision = 'b4d8f2a6c1e9'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'photo_share',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('token', sa.String(length=128), nullable=False),
        sa.Column('path', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token'),
    )
    op.create_index('ix_photo_share_project_id', 'photo_share', ['project_id'], unique=False)


def downgrade():
    op.drop_index('ix_photo_share_project_id', table_name='photo_share')
    op.drop_table('photo_share')
