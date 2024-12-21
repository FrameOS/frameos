import uuid
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import LargeBinary, Integer, String, Text
from sqlalchemy.orm import mapped_column
from app.database import Base


class Template(Base):
    __tablename__ = 'template'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = mapped_column(String(128), nullable=False)
    description = mapped_column(Text(), nullable=True)
    scenes = mapped_column(JSON, nullable=True)
    config = mapped_column(JSON, nullable=True)
    image = mapped_column(LargeBinary, nullable=True)
    image_width = mapped_column(Integer, nullable=True)
    image_height = mapped_column(Integer, nullable=True)

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
