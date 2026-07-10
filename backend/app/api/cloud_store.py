"""Publish scenes to the FrameOS Cloud store (STORE-TODO Phase 2).

The payload is the same template interchange zip the backups use; the cloud
keeps immutable versions per scene. Publishing needs the ``store:publish``
scope on the cloud link. Browsing the public store needs nothing at all —
it is a plain scenes repository at ``{provider}/api/store/repository.json``
(auto-added per project in app/api/repositories.py).
"""
from __future__ import annotations

import base64
from http import HTTPStatus

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.cloud_backups import _require_linked, _require_user
from app.api.templates import template_zip_bytes
from app.database import get_db
from app.models.template import Template
from app.models.user import User
from app.schemas.cloud import CloudStatusResponse, CloudStorePublishRequest
from app.tenancy import get_user_project
from app.utils import cloud_link

from . import api_user


@api_user.post("/cloud/store/publish", response_model=CloudStatusResponse)
async def publish_template_to_store(
    data: CloudStorePublishRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    user = _require_user(current_user)
    link, access_token = _require_linked(db, "store:publish")
    template = db.query(Template).filter_by(id=data.template_id).first()
    if template is None or get_user_project(db, user, template.project_id) is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template not found")

    payload: dict = {
        "name": template.name,
        "content_base64": base64.b64encode(template_zip_bytes(template)).decode(),
        "content_type": "application/zip",
    }
    if template.description:
        payload["description"] = template.description
    # Omitted visibility means: private on first publish, unchanged afterwards.
    if data.visibility in ("private", "public"):
        payload["visibility"] = data.visibility

    try:
        status_code, response = await cloud_link.store_publish(link.provider_url, access_token, payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")
    return {"status": "published", "scene": response.get("scene")}
