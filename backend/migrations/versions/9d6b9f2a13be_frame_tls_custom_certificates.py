"""frame tls custom certificates

Revision ID: 9d6b9f2a13be
Revises: 6f45af81d344
Create Date: 2026-02-10 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9d6b9f2a13be'
down_revision: Union[str, None] = '6f45af81d344'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('frame', sa.Column('tls_server_cert', sa.String(), nullable=True))
    op.add_column('frame', sa.Column('tls_server_key', sa.String(), nullable=True))
    op.add_column('frame', sa.Column('tls_client_ca_cert', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('frame', 'tls_client_ca_cert')
    op.drop_column('frame', 'tls_server_key')
    op.drop_column('frame', 'tls_server_cert')
