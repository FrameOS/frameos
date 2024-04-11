import requests
import uuid
from app import db
from sqlalchemy.dialects.sqlite import JSON
from datetime import datetime
from urllib.parse import urljoin


class Repository(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(128), nullable=False)
    url = db.Column(db.Text(), nullable=True)
    last_updated_at = db.Column(db.DateTime(), nullable=True)
    templates = db.Column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'url': self.url,
            'last_updated_at': self.last_updated_at,
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
                    if not self.name and 'name' in json_response:
                        self.name = json_response.get('name', None) or "Unnamed Repository"
                else:
                    self.templates = json_response
            except ValueError:
                self.templates = []

            for template in self.templates:
                if template.get('image', '').startswith('./'):
                    template['image'] = urljoin(self.url, template['image'])
                if template.get('zip', '').startswith('./'):
                    template['zip'] = urljoin(self.url, template['zip'])
