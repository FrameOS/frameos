"""cloud backups

Revision ID: 9d2f4c8a7b31
Revises: 29c824d6b6c3
Create Date: 2026-05-19 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite


# revision identifiers, used by Alembic.
revision = '9d2f4c8a7b31'
down_revision = '29c824d6b6c3'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('user', schema=None) as batch_op:
        batch_op.alter_column('password', existing_type=sa.String(length=128), type_=sa.String(length=256))

    op.add_column('user', sa.Column('cloud_auth_required', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('user', sa.Column('cloud_user_id', sa.String(length=128), nullable=True))
    op.add_column('user', sa.Column('cloud_backend_link_id', sa.String(length=128), nullable=True))
    op.add_column('user', sa.Column('cloud_backend_name', sa.String(length=256), nullable=True))
    op.add_column('user', sa.Column('cloud_backend_url', sa.String(length=1024), nullable=True))
    op.add_column('user', sa.Column('cloud_backend_token', sa.Text(), nullable=True))

    op.create_table(
        'cloud_auth_session',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('state_hash', sa.String(length=128), nullable=False),
        sa.Column('purpose', sa.String(length=32), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('backend_name', sa.String(length=256), nullable=False),
        sa.Column('backend_url', sa.String(length=1024), nullable=False),
        sa.Column('redirect_uri', sa.String(length=1024), nullable=False),
        sa.Column('pending_email', sa.String(length=120), nullable=True),
        sa.Column('pending_password_hash', sa.String(length=256), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('consumed_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['user.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('state_hash'),
    )
    op.create_table(
        'cloud_export_object',
        sa.Column('id', sa.String(length=80), nullable=False),
        sa.Column('kind', sa.String(length=64), nullable=False),
        sa.Column('locator', sqlite.JSON(), nullable=False),
        sa.Column('content_type', sa.String(length=256), nullable=True),
        sa.Column('size', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'cloud_import_session',
        sa.Column('id', sa.String(length=80), nullable=False),
        sa.Column('manifest', sqlite.JSON(), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('committed_at', sa.DateTime(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'cloud_import_object',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(length=80), nullable=False),
        sa.Column('object_id', sa.String(length=160), nullable=False),
        sa.Column('content_type', sa.String(length=256), nullable=True),
        sa.Column('data', sa.LargeBinary(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['session_id'], ['cloud_import_session.id']),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade():
    op.drop_table('cloud_import_object')
    op.drop_table('cloud_import_session')
    op.drop_table('cloud_export_object')
    op.drop_table('cloud_auth_session')

    op.drop_column('user', 'cloud_backend_token')
    op.drop_column('user', 'cloud_backend_url')
    op.drop_column('user', 'cloud_backend_name')
    op.drop_column('user', 'cloud_backend_link_id')
    op.drop_column('user', 'cloud_user_id')
    op.drop_column('user', 'cloud_auth_required')

    with op.batch_alter_table('user', schema=None) as batch_op:
        batch_op.alter_column('password', existing_type=sa.String(length=256), type_=sa.String(length=128))
