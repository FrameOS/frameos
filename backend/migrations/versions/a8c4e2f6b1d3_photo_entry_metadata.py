"""photo entries: what each photo carries besides its pixels

Revision ID: a8c4e2f6b1d3
Revises: 5e2a9c71d4b8
Create Date: 2026-10-18 12:00:00.000000

A photo's metadata (docs/photos.md "Metadata"): its EXIF fields by group,
its location (EXIF GPS, else XMP), and which other blocks it holds. Read
from the bytes by app/utils/photo_metadata.py at upload, after a resize and
after POST /api/photos/metadata removes something. NULL means not read yet:
a photo stored before this, read in the background when its folder is
listed, or on demand by GET /api/photos/metadata. The share routes never
send it.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'a8c4e2f6b1d3'
down_revision = '5e2a9c71d4b8'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('photo_entry') as batch_op:
        batch_op.add_column(sa.Column('metadata', sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table('photo_entry') as batch_op:
        batch_op.drop_column('metadata')
