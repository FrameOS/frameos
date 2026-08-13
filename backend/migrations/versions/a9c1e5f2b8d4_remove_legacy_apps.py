"""Replace legacy/* app nodes with their render + data equivalents

The legacy apps were removed from the codebase. Any scene still using them —
on frames or in saved templates — is rewritten in place: the legacy node
becomes the matching render/logic node in the render chain, fed by a new
data/* node (see app/utils/legacy_app_migration.py for the exact mapping).

Revision ID: a9c1e5f2b8d4
Revises: e7a3b9c4d2f6
Create Date: 2026-08-13

"""
from sqlalchemy.orm import attributes, load_only

# revision identifiers, used by Alembic.
revision = 'a9c1e5f2b8d4'
down_revision = 'e7a3b9c4d2f6'
branch_labels = None
depends_on = None


def upgrade():
    from app.models import Frame
    from app.models.template import Template
    from app.database import SessionLocal
    from app.utils.legacy_app_migration import migrate_legacy_apps_in_scenes

    db = SessionLocal()
    try:
        frames = db.query(Frame).options(load_only(Frame.id, Frame.scenes)).all()
        for frame in frames:
            if not isinstance(frame.scenes, list):
                continue
            scenes = [dict(scene) if isinstance(scene, dict) else scene for scene in frame.scenes]
            if migrate_legacy_apps_in_scenes(scenes):
                frame.scenes = scenes
                attributes.flag_modified(frame, "scenes")
                db.add(frame)
                db.commit()

        templates = db.query(Template).options(load_only(Template.id, Template.scenes)).all()
        for template in templates:
            if not isinstance(template.scenes, list):
                continue
            scenes = [dict(scene) if isinstance(scene, dict) else scene for scene in template.scenes]
            if migrate_legacy_apps_in_scenes(scenes):
                template.scenes = scenes
                attributes.flag_modified(template, "scenes")
                db.add(template)
                db.commit()
    finally:
        db.close()


def downgrade():
    # The legacy apps no longer exist in the codebase; the rewritten scenes
    # remain valid on older versions too, so there is nothing to restore.
    pass
