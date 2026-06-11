"""log and metrics frame_id timestamp indexes

Revision ID: 961ada4af571
Revises: 2c4a6f8d9b10
Create Date: 2026-06-11 02:01:22.466172

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '961ada4af571'
down_revision = '2c4a6f8d9b10'
branch_labels = None
depends_on = None


def upgrade():
    # Log/metric ingestion counts and prunes per frame on every batch; without
    # these indexes each COUNT/ORDER BY scanned the whole table.
    op.create_index('ix_log_frame_id_timestamp', 'log', ['frame_id', 'timestamp'], unique=False)
    op.create_index('ix_metrics_frame_id_timestamp', 'metrics', ['frame_id', 'timestamp'], unique=False)


def downgrade():
    op.drop_index('ix_metrics_frame_id_timestamp', table_name='metrics')
    op.drop_index('ix_log_frame_id_timestamp', table_name='log')
