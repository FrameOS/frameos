from sqlalchemy import Integer, String
from sqlalchemy.orm import Session, mapped_column
from sqlalchemy.dialects.sqlite import JSON

from app.database import Base


GALLERY_DEFAULTS = {"imageStorageLocation": "local path ./db/gallery/"}

class Settings(Base):
    __tablename__ = 'settings'
    id = mapped_column(Integer, primary_key=True)
    key = mapped_column(String(128), nullable=False)
    value = mapped_column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'key': self.key,
            'value': self.value,
        }


def get_settings_dict(db: Session) -> dict:
    settings = {setting.key: setting.value for setting in db.query(Settings).all()}

    gallery_settings = settings.get("gallery") or {}
    if not isinstance(gallery_settings, dict):
        gallery_settings = {}
    gallery_settings = {**GALLERY_DEFAULTS, **gallery_settings}
    settings["gallery"] = gallery_settings

    return settings
