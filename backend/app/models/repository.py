import requests
import uuid
from sqlalchemy.dialects.sqlite import JSON
from datetime import datetime
from urllib.parse import urljoin
from sqlalchemy import String, Text, DateTime
from sqlalchemy.orm import mapped_column
from app.database import Base


class Repository(Base):
    __tablename__ = 'repository'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = mapped_column(String(128), nullable=False)
    description = mapped_column(Text(), nullable=True)
    url = mapped_column(Text(), nullable=True)
    last_updated_at = mapped_column(DateTime(), nullable=True)
    templates = mapped_column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'url': self.url,
            'last_updated_at': self.last_updated_at.isoformat() if self.last_updated_at else None,
            'templates': self.templates,
        }

    def to_json(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'url': self.url,
            'last_updated_at': str(self.last_updated_at),
            'templates': self.templates,
        }

    def update_templates(self):
        response = requests.get(self.url)
        if response.status_code == 200:
            self.last_updated_at = datetime.utcnow()
            try:
                json_response = response.json()
                if isinstance(json_response, dict):
                    self.templates = json_response.get('templates', [])
                    if 'name' in json_response:
                        self.name = json_response.get('name', None) or "Unnamed Repository"
                    if 'description' in json_response:
                        self.description = json_response.get('description', None)
                else:
                    self.templates = json_response
            except ValueError:
                self.templates = []

            for template in self.templates:
                if template.get('image', '').startswith('./'):
                    template['image'] = urljoin(self.url, template['image'])
                if template.get('zip', '').startswith('./'):
                    template['zip'] = urljoin(self.url, template['zip'])
