"""frame access

Revision ID: f8db11069084
Revises: 7f2a8719a009
Create Date: 2024-02-06 09:35:11.908314

"""
from alembic import op
import sqlalchemy as sa
from app.utils.token import secure_token


# revision identifiers, used by Alembic.
revision = 'f8db11069084'
down_revision = '7f2a8719a009'
branch_labels = None
depends_on = None


def upgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.add_column(sa.Column('frame_access', sa.String(length=50), nullable=True))

    from app.models import Frame
    from app.database import SessionLocal
    db = SessionLocal()

    frames = db.query(Frame.id).all()
    for (frame_id,) in frames:
        db.execute(
            sa.update(Frame).
            where(Frame.id == frame_id).
            values({
                Frame.frame_access_key: secure_token(20),
                Frame.frame_access: "private"
            })
        )

    # Commit changes
    db.commit()
    db.close()
    # ### end Alembic commands ###


def downgrade():
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('frame', schema=None) as batch_op:
        batch_op.drop_column('frame_access')

    # ### end Alembic commands ###
