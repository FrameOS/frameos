"""photo entries

Revision ID: d4e8f1a2b3c5
Revises: 1329ea888ea9
Create Date: 2026-10-14 16:00:00.000000

The photo library's rows (docs/photos.md): files and folders of a project,
with the bytes in the object store under `photos/<sha256>`. Before this the
backend listed a folder on disk; the table is the cloud's photo_entries.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd4e8f1a2b3c5'
down_revision = '1329ea888ea9'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'photo_entry',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('path', sa.Text(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('content_type', sa.String(length=255), nullable=True),
        sa.Column('sha256', sa.String(length=64), nullable=True),
        sa.Column('object_key', sa.String(length=512), nullable=True),
        sa.Column('thumb_object_key', sa.String(length=512), nullable=True),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('colors', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'path', name='uq_photo_entry_project_path'),
    )
    op.create_index('ix_photo_entry_project_id', 'photo_entry', ['project_id'], unique=False)
    op.create_index('ix_photo_entry_object_key', 'photo_entry', ['object_key'], unique=False)


def downgrade():
    op.drop_index('ix_photo_entry_object_key', table_name='photo_entry')
    op.drop_index('ix_photo_entry_project_id', table_name='photo_entry')
    op.drop_table('photo_entry')
