from sqlalchemy import Integer, String
from sqlalchemy.orm import Session, mapped_column
from app.database import Base
from sqlalchemy.dialects.sqlite import JSON

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
    return {setting.key: setting.value for setting in db.query(Settings).all()}
