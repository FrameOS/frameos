import httpx
import json
import uuid
from sqlalchemy.dialects.sqlite import JSON
from datetime import datetime
from urllib.parse import urljoin
from sqlalchemy import ForeignKey, Integer, String, Text, DateTime
from sqlalchemy.orm import mapped_column
from app.database import Base


class Repository(Base):
    __tablename__ = 'repository'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    name = mapped_column(String(128), nullable=False)
    description = mapped_column(Text(), nullable=True)
    url = mapped_column(Text(), nullable=True)
    last_updated_at = mapped_column(DateTime(), nullable=True)
    templates = mapped_column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'name': self.name,
            'description': self.description,
            'url': self.url,
            'last_updated_at': self.last_updated_at.isoformat() if self.last_updated_at else None,
            'templates': self.templates,
        }

    def to_json(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'name': self.name,
            'description': self.description,
            'url': self.url,
            'last_updated_at': str(self.last_updated_at),
            'templates': self.templates,
        }

    async def update_templates(self):
        # The URL is user data: the resolver guard refuses loopback /
        # link-local / reserved targets, no redirects are followed (httpx
        # default) and the body is streamed under a cap. Any failure leaves
        # the cached templates as they were, like a non-200 always did.
        from app.utils.network import TargetBlocked, check_target_host
        from app.utils.upload_limits import MAX_REPOSITORY_JSON_BYTES, fetch_body_limited
        from fastapi import HTTPException
        from urllib.parse import urlparse

        parsed = urlparse(self.url or "")
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return
        try:
            await check_target_host(parsed.hostname)
        except TargetBlocked:
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                content = await fetch_body_limited(client, self.url, MAX_REPOSITORY_JSON_BYTES)
        except (httpx.HTTPError, HTTPException):
            return
        if True:
            self.last_updated_at = datetime.utcnow()
            try:
                json_response = json.loads(content)
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

            # Repository-relative assets are resolved once, here, because the
            # cached copy is what the scene picker renders. `or ''` because a
            # template may carry an explicit null image/zip, and an
            # AttributeError here would abort the whole refresh and leave the
            # previous (by then possibly dead) URLs in place.
            for template in self.templates:
                if (template.get('image') or '').startswith('./'):
                    template['image'] = urljoin(self.url, template['image'])
                if (template.get('zip') or '').startswith('./'):
                    template['zip'] = urljoin(self.url, template['zip'])
