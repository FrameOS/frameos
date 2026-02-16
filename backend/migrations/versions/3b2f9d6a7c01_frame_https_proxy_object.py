"""frame https proxy object

Revision ID: 3b2f9d6a7c01
Revises: 11a2d26ea7e7
Create Date: 2026-02-16 00:00:00.000000

"""

import json
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '3b2f9d6a7c01'
down_revision = '11a2d26ea7e7'
branch_labels = None
depends_on = None


def upgrade():
    # op.add_column('frame', sa.Column('https_proxy', sa.JSON(), nullable=True))
    # select all frames and migrate existing TLS fields to the new https_proxy JSON field
    connection = op.get_bind()
    frames = connection.execute(sa.text("SELECT id, enable_tls, tls_port, expose_only_tls_port, tls_server_cert, tls_server_key, tls_client_ca_cert, tls_server_cert_not_valid_after, tls_client_ca_cert_not_valid_after FROM frame")).fetchall()
    for frame in frames:
        https_proxy = {
            'enable': frame.enable_tls,
            'port': frame.tls_port,
            'expose_only_port': frame.expose_only_tls_port,
            'server_cert': frame.tls_server_cert,
            'server_key': frame.tls_server_key,
            'client_ca_cert': frame.tls_client_ca_cert,
        }
        connection.execute(
            sa.text("UPDATE frame SET https_proxy = :https_proxy WHERE id = :id"),
            {"https_proxy": json.dumps(https_proxy), "id": frame.id}
        )


    op.drop_column('frame', 'tls_client_ca_cert_not_valid_after')
    op.drop_column('frame', 'tls_server_cert_not_valid_after')
    op.drop_column('frame', 'tls_client_ca_cert')
    op.drop_column('frame', 'tls_server_key')
    op.drop_column('frame', 'tls_server_cert')
    op.drop_column('frame', 'expose_only_tls_port')
    op.drop_column('frame', 'tls_port')
    op.drop_column('frame', 'enable_tls')


def downgrade():
    op.add_column('frame', sa.Column('enable_tls', sa.Boolean(), nullable=True))
    op.add_column('frame', sa.Column('tls_port', sa.Integer(), nullable=True))
    op.add_column('frame', sa.Column('expose_only_tls_port', sa.Boolean(), nullable=True))
    op.add_column('frame', sa.Column('tls_server_cert', sa.String(), nullable=True))
    op.add_column('frame', sa.Column('tls_server_key', sa.String(), nullable=True))
    op.add_column('frame', sa.Column('tls_client_ca_cert', sa.String(), nullable=True))
    op.add_column('frame', sa.Column('tls_server_cert_not_valid_after', sa.DateTime(), nullable=True))
    op.add_column('frame', sa.Column('tls_client_ca_cert_not_valid_after', sa.DateTime(), nullable=True))
    op.drop_column('frame', 'https_proxy')
