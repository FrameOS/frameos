from app import db
from sqlalchemy.dialects.sqlite import JSON

class Settings(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(128), nullable=False)
    value = db.Column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'key': self.key,
            'value': self.value,
        }


def get_settings_dict() -> dict:
    return {setting.key: setting.value for setting in Settings.query.all()}
