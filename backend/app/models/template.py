# app/models/template.py

import uuid
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import Column, String, Text, Integer, LargeBinary
from app.core.database import Base

class Template(Base):
    __tablename__ = "templates"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(128), nullable=False)
    description = Column(Text, nullable=True)
    scenes = Column(JSON, nullable=True)
    config = Column(JSON, nullable=True)
    image = Column(LargeBinary, nullable=True)
    image_width = Column(Integer, nullable=True)
    image_height = Column(Integer, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'scenes': self.scenes,
            'config': self.config,
            'image': f'/api/templates/{self.id}/image' if self.image and self.image_width and self.image_height else None,
            'imageWidth': self.image_width,
            'imageHeight': self.image_height,
        }
