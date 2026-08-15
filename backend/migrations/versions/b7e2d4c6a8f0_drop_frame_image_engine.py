"""drop frame image engine

ImageMagick is gone from the runtime; every frame decodes with Pixie. Old
values ("", "pixie", "imagemagick") are simply dropped.

Revision ID: b7e2d4c6a8f0
Revises: a9c1e5f2b8d4
Create Date: 2026-08-15 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b7e2d4c6a8f0"
down_revision = "a9c1e5f2b8d4"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("frame") as batch_op:
        batch_op.drop_column("image_engine")


def downgrade():
    with op.batch_alter_table("frame") as batch_op:
        batch_op.add_column(sa.Column("image_engine", sa.String(length=32), nullable=True))
