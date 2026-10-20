"""frames this backend manages as their provider: link + claim tokens

Revision ID: c7e1a9d4b2f6
Revises: a8c4e2f6b1d3
Create Date: 2026-10-20 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'c7e1a9d4b2f6'
down_revision = 'a8c4e2f6b1d3'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'frame_provider_link',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('frame_id', sa.Integer(), nullable=False),
        sa.Column('public_key', sa.Text(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('scopes', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('local_origin', sa.String(length=512), nullable=True),
        sa.Column('connected', sa.Boolean(), nullable=False),
        sa.Column('session_id', sa.String(length=36), nullable=True),
        sa.Column('last_seen_at', sa.DateTime(), nullable=True),
        sa.Column('frameos_version', sa.String(length=64), nullable=True),
        sa.Column('hardware', sqlite.JSON(), nullable=True),
        sa.Column('last_state', sqlite.JSON(), nullable=True),
        sa.Column('scenes_checksum', sa.String(length=128), nullable=True),
        sa.ForeignKeyConstraint(['frame_id'], ['frame.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('frame_id'),
        sa.UniqueConstraint('token_hash'),
    )
    with op.batch_alter_table('frame_provider_link', schema=None) as batch_op:
        batch_op.create_index('ix_frame_provider_link_project_id', ['project_id'], unique=False)
    op.create_table(
        'frame_claim_token',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('frame_id', sa.Integer(), nullable=True),
        sa.Column('name', sa.String(length=256), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.Column('used_public_key', sa.Text(), nullable=True),
        sa.Column('used_frame_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['frame_id'], ['frame.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['used_frame_id'], ['frame.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    with op.batch_alter_table('frame_claim_token', schema=None) as batch_op:
        batch_op.create_index('ix_frame_claim_token_project_id', ['project_id'], unique=False)


def downgrade():
    op.drop_table('frame_claim_token')
    op.drop_table('frame_provider_link')
