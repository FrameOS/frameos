from typing import Optional

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Session, mapped_column
from app.database import Base
from sqlalchemy.dialects.sqlite import JSON
from app.utils.timezone import guess_system_timezone

class Settings(Base):
    __tablename__ = 'settings'
    __table_args__ = (UniqueConstraint("project_id", "key", name="uq_settings_project_key"),)

    id = mapped_column(Integer, primary_key=True)
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
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
            "wifiSSID": "",
            "wifiPassword": "",
        },
    }


def get_settings_dict(db: Optional[Session], project_id: Optional[int] = None) -> dict:
    settings = default_settings()
    if db is None:
        return settings
    if project_id is None:
        raise ValueError("project_id is required when loading settings from the database")

    query = db.query(Settings).filter(Settings.project_id == project_id)

    for setting in query.all():
        if setting.key == "defaults" and isinstance(setting.value, dict):
            settings["defaults"] = {
                **settings["defaults"],
                **setting.value,
            }
        else:
            settings[setting.key] = setting.value
    return settings
