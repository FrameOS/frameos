"""create gallery tables

Revision ID: e8a66c76b1a3
Revises: 6d47535677de
Create Date: 2025-03-09 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e8a66c76b1a3'
down_revision = '6d47535677de'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'gallery',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        'gallery_image',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('gallery_id', sa.Integer(), sa.ForeignKey('gallery.id', ondelete='CASCADE'), nullable=False),
        sa.Column('filename', sa.String(length=512), nullable=False),
        sa.Column('original_path', sa.String(length=1024), nullable=False),
        sa.Column('thumbnail_path', sa.String(length=1024), nullable=True),
        sa.Column('mime_type', sa.String(length=128), nullable=True),
        sa.Column('extension', sa.String(length=16), nullable=True),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('file_size', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )

    op.create_index('ix_gallery_image_gallery_id', 'gallery_image', ['gallery_id'])


def downgrade():
    op.drop_index('ix_gallery_image_gallery_id', table_name='gallery_image')
    op.drop_table('gallery_image')
    op.drop_table('gallery')
