from typing import Optional

from sqlalchemy import Integer, String
from sqlalchemy.orm import Session, mapped_column
from app.database import Base
from sqlalchemy.dialects.sqlite import JSON
from app.utils.timezone import guess_system_timezone

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


def default_settings() -> dict:
    return {
        "defaults": {
            "timezone": guess_system_timezone(),
        },
    }


def get_settings_dict(db: Optional[Session]) -> dict:
    settings = default_settings()
    if db is None:
        return settings

    for setting in db.query(Settings).all():
        if setting.key == "defaults" and isinstance(setting.value, dict):
            settings["defaults"] = {
                **settings["defaults"],
                **setting.value,
            }
        else:
            settings[setting.key] = setting.value
    return settings
