"""chats: a chat may be about no frame at all

Revision ID: b3d7f1a9c2e5
Revises: a8c4e2f6b1d3
Create Date: 2026-10-20 12:00:00.000000

The AI box on the frames home opens a chat before any frame is picked ("update
the kitchen frame"): the assistant finds the frame itself with its tools. Such
a chat has no frame_id (docs/ai-chat.md).
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b3d7f1a9c2e5'
down_revision = 'a8c4e2f6b1d3'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('chat') as batch_op:
        batch_op.alter_column('frame_id', existing_type=sa.Integer(), nullable=True)


def downgrade():
    op.execute("DELETE FROM chat_message WHERE chat_id IN (SELECT id FROM chat WHERE frame_id IS NULL)")
    op.execute("DELETE FROM chat WHERE frame_id IS NULL")
    with op.batch_alter_table('chat') as batch_op:
        batch_op.alter_column('frame_id', existing_type=sa.Integer(), nullable=False)
