"""frame command queue and sleep forecast

Revision ID: f1a2b3c4d5e6
Revises: c3d8e1f5a7b2
Create Date: 2026-10-11 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'f1a2b3c4d5e6'
down_revision = 'c3d8e1f5a7b2'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'frame_command',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('frame_id', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(length=64), nullable=False),
        sa.Column('payload', sqlite.JSON(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('detail', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('sent_at', sa.DateTime(), nullable=True),
        sa.Column('acked_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['frame_id'], ['frame.id']),
        sa.ForeignKeyConstraint(['project_id'], ['project.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('frame_command', schema=None) as batch_op:
        batch_op.create_index('ix_frame_command_project_id', ['project_id'], unique=False)
        batch_op.create_index('ix_frame_command_frame_id', ['frame_id'], unique=False)
        batch_op.create_index(
            'ix_frame_command_frame_status_created', ['frame_id', 'status', 'created_at'], unique=False
        )
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('next_wake_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column('next_render_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column('sleep_reason', sa.String(length=32), nullable=True))


def downgrade():
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('sleep_reason')
        batch_op.drop_column('next_render_at')
        batch_op.drop_column('next_wake_at')
    op.drop_table('frame_command')
