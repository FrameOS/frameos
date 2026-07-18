"""Publish scenes to the FrameOS Cloud store (STORE-TODO Phases 2-3).

The payload is the same template interchange zip the backups use; the cloud
keeps immutable versions per scene. Publishing needs the ``store:publish``
scope on the cloud link. Browsing the public store needs nothing at all —
it is a plain scenes repository at ``{provider}/api/store/repository.json``
(auto-added per project in app/api/repositories.py).

"My cloud drive" is the account's own scenes, private ones included. The
browser cannot attach the link token to <img> tags, so this module proxies
the drive listing and preview images; zips install through the normal
``POST /api/templates {url}`` flow, which attaches the link token for
provider URLs (see cloud_headers_for_url).
"""
from __future__ import annotations

import base64
import io
from http import HTTPStatus

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException
from fastapi.responses import Response
from PIL import Image
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.cloud_backups import _require_linked, _require_user
from app.api.templates import template_zip_bytes
from app.database import get_db
from app.models.frame import Frame
from app.models.template import Template
from app.models.user import User
from app.redis import get_redis
from app.schemas.cloud import CloudStatusResponse, CloudStorePublishRequest
from app.tenancy import get_user_project
from app.utils import cloud_link

from . import api_user


async def _template_from_request(
    data: CloudStorePublishRequest, db: Session, redis: Redis, user: User
) -> Template:
    """The template to publish: an existing one, or a transient one built
    from inline scenes ("Save to cloud drive" straight off a frame)."""
    if data.template_id:
        template = db.query(Template).filter_by(id=data.template_id).first()
        if template is None or get_user_project(db, user, template.project_id) is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template not found")
        return template

    if not data.name or not data.scenes:
        raise HTTPException(
            status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
            detail="Provide template_id, or name and scenes",
        )

    template = Template(name=data.name, description=data.description, scenes=data.scenes, config={})

    if data.from_frame_id:
        frame = db.query(Frame).filter_by(id=data.from_frame_id).first()
        if frame is None or get_user_project(db, user, frame.project_id) is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
        template.project_id = frame.project_id
        image = None
        if data.image_scene_id:
            from app.models.scene_image import SceneImage

            scene_image = (
                db.query(SceneImage)
                .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id=data.image_scene_id)
                .first()
            )
            if scene_image:
                image = scene_image.image
        if not image:
            image = await redis.get(f"frame:{frame.id}:image")
        if image:
            try:
                img_obj = Image.open(io.BytesIO(image))
                template.image = image
                template.image_width = img_obj.width
                template.image_height = img_obj.height
            except Exception:  # noqa: BLE001 — a broken snapshot just means no preview
                pass

    return template


@api_user.post("/cloud/store/publish", response_model=CloudStatusResponse)
async def publish_template_to_store(
    data: CloudStorePublishRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    current_user: User | None = Depends(get_current_user),
):
    user = _require_user(current_user)
    link, access_token = _require_linked(db, "store:publish")
    template = await _template_from_request(data, db, redis, user)

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


@api_user.get("/cloud/store/drive", response_model=CloudStatusResponse)
async def cloud_store_drive(
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    _require_user(current_user)
    link, access_token = _require_linked(db, "store:publish")
    try:
        status_code, payload = await cloud_link.store_drive(link.provider_url, access_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        detail = payload.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud error: {detail}")

    # Preview images of private scenes need the link token, which the browser
    # does not have — point them at our authenticated proxy below instead.
    for template in payload.get("templates", []):
        scene_id = template.get("sceneId")
        if scene_id and template.get("image"):
            template["image"] = f"/api/cloud/store/drive/image/{scene_id}"
    return payload


@api_user.get("/cloud/store/drive/image/{scene_id}")
async def cloud_store_drive_image(
    scene_id: str,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    _require_user(current_user)
    link, access_token = _require_linked(db, "store:publish")
    try:
        status_code, content_type, content = await cloud_link.cloud_get_binary(
            link.provider_url, f"/api/store/scenes/{scene_id}/image", access_token
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Image not found")
    return Response(content, media_type=content_type, headers={"cache-control": "private, max-age=300"})
