"""frames: the render scale (what JSX from a .tsx or .jsx app is laid out for)

Revision ID: d5f9b3c1e7a4
Revises: c4e8a2d7f1b9
Create Date: 2026-10-29 12:00:00.000000

frame.json `renderScale` (docs/jsx-ui.md "Scale"): a UI from a .tsx or .jsx
app is laid out for a panel this many times smaller and drawn sharp at full
size. 0 is automatic (the panel's shorter edge over 600 px, in quarter steps,
at least 1), which every existing frame gets.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'd5f9b3c1e7a4'
down_revision = 'c4e8a2d7f1b9'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.add_column(sa.Column('render_scale', sa.Double(), nullable=False, server_default='0'))


def downgrade():
    with op.batch_alter_table('frame') as batch_op:
        batch_op.drop_column('render_scale')
