"""api tokens

Revision ID: d4e5f6a7b8c9
Revises: c3d8e1f5a7b2
Create Date: 2026-10-11 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd4e5f6a7b8c9'
down_revision = 'c3d8e1f5a7b2'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'api_token',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('hint', sa.String(length=32), nullable=False),
        sa.Column('access', sa.String(length=16), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_api_token_user_id', 'api_token', ['user_id'], unique=False)


def downgrade():
    op.drop_index('ix_api_token_user_id', table_name='api_token')
    op.drop_table('api_token')
