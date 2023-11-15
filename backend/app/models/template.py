import uuid
from app import db
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import LargeBinary


class Template(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(128), nullable=False)
    description = db.Column(db.Text(), nullable=True)
    scenes = db.Column(JSON, nullable=True)
    config = db.Column(JSON, nullable=True)
    image = db.Column(LargeBinary, nullable=True)
    image_width = db.Column(db.Integer, nullable=True)
    image_height = db.Column(db.Integer, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'scenes': self.scenes,
            'config': self.config,
            'image': f'/api/templates/{self.id}/image' if self.image and self.image_width and self.image_height else None,
            'image_width': self.image_width,
            'image_height': self.image_height,
        }
