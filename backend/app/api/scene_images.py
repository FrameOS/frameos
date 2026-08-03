import io
import json
import re
from datetime import datetime
from http import HTTPStatus
from urllib.parse import urlparse

import httpx
from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.config import config
from app.database import get_db
from app.models.repository import Repository
from app.models.scene_image import SceneImage            # created earlier
from app.models.frame import Frame
from app.models.template import Template
from . import api_open, api_project
from app.utils.jwt_tokens import validate_scoped_token
from app.utils.network import is_safe_host
from app.api.auth import get_current_user_from_request
from app.tenancy import current_project_id, get_user_project


SCENE_IMAGE_CACHE_HEADERS = {"Cache-Control": "private, max-age=86400"}

# A scene cover is a preview, not a payload: anything larger than this is not
# something we want to hold in memory, thumbnail, and store per scene.
MAX_COPIED_IMAGE_BYTES = 16 * 1024 * 1024
COPIED_IMAGE_TIMEOUT_SECONDS = 15

SYSTEM_TEMPLATE_IMAGE_PATH = re.compile(
    r"^/api/repositories/system/([^/]+)/templates/([^/]+)/image$"
)


def _generate_placeholder(
    width: int | None = 320,
    height: int | None = 240,
    *,
    font_path: str = "../frameos/assets/compiled/fonts/Ubuntu-Regular.ttf",
    font_size: int = 32,
    message: str = "No snapshot",
) -> bytes:
    """
    Return a PNG (bytes) that shows a black rectangle with centred white text.

    Parameters
    ----------
    width, height  :  Dimensions in pixels; defaults are 400×300.
    font_path      :  Path to a scalable font file (TTF/OTF).  If omitted,
                      Pillow’s 8‑pixel bitmap font is used.
    font_size      :  Point size for the scalable font.
    message        :  The text to write.
    """
    width, height = int(width or 320), int(height or 240)

    img = Image.new("RGB", (width, height), "#1f2937")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, font_size)

    left, top, right, bottom = draw.textbbox((0, 0), message, font=font)
    text_w, text_h = right - left, bottom - top

    draw.text(
        ((width - text_w) / 2, (height - text_h) / 2),
        message,
        fill="white",
        font=font,
    )

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()

def _generate_thumbnail(image_bytes: bytes) -> tuple[bytes, int, int]:
    """
    Generate a JPEG thumbnail whose width and height never exceed 320px,
    while preserving aspect ratio.
    Returns (jpeg_bytes, new_width, new_height).
    """
    with Image.open(io.BytesIO(image_bytes)) as img:
        # ensure RGB
        if img.mode != "RGB":
            img = img.convert("RGB")

        orig_width, orig_height = img.size

        # scale factor that keeps both sides ≤ 320
        scale = min(320 / orig_width, 320 / orig_height, 1.0)
        new_width  = int(round(orig_width  * scale))
        new_height = int(round(orig_height * scale))

        img = img.resize((new_width, new_height), Image.Resampling.BICUBIC)

        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        return buf.read(), new_width, new_height


@api_open.get("/projects/{project_id}/frames/{frame_id}/scene_images/{scene_id}")
async def get_scene_image(
    project_id: int,
    frame_id: int,
    scene_id: str,
    request: Request,
    token: str | None = None,
    db: Session = Depends(get_db),
):
    """
    Fetch the latest stored SceneImage.
    If none exists, return a placeholder that matches the frame’s native
    width/height so the UI keeps its layout.
    """

    if config.HASSIO_RUN_MODE != 'ingress':
        user = await get_current_user_from_request(request, db)
        if user is not None and get_user_project(db, user, project_id) is not None:
            pass
        else:
            validate_scoped_token(token, expected_subject=f"project={project_id}:frame={frame_id}")


    img_row: SceneImage | None = (
        db.query(SceneImage)
        .filter_by(project_id=project_id, frame_id=frame_id, scene_id=scene_id)
        .order_by(SceneImage.timestamp.desc())
        .first()
    )

    wants_thumb = request.query_params.get("thumb") == "1"

    if img_row:
        # Fresh snapshot found. Generate and save thumbnail only when a
        # thumbnail is requested, so full-size image reads stay cheap.
        if wants_thumb and not getattr(img_row, 'thumb_image', None):
            thumb, t_width, t_height = _generate_thumbnail(img_row.image)
            img_row.thumb_image = thumb
            img_row.thumb_width = t_width
            img_row.thumb_height = t_height
            db.add(img_row)
            db.commit()
            db.refresh(img_row)
        if wants_thumb:
            return StreamingResponse(
                io.BytesIO(img_row.thumb_image),
                media_type="image/jpeg",
                headers=SCENE_IMAGE_CACHE_HEADERS,
            )
        else:
            return StreamingResponse(
                io.BytesIO(img_row.image),
                media_type="image/png",
                headers=SCENE_IMAGE_CACHE_HEADERS,
            )

    frame: Frame | None = db.query(Frame).filter_by(project_id=project_id, id=frame_id).first()
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")

    if frame.width is None or frame.height is None:
        new_width, new_height = 320, 240
    elif wants_thumb:
        scale = min(320 / frame.width, 320 / frame.height, 1.0)
        new_width  = int(round(frame.width  * scale))
        new_height = int(round(frame.height * scale))
    else:
        new_width  = frame.width
        new_height = frame.height

    if frame.rotate == 90 or frame.rotate == 270:
        new_width, new_height = new_height, new_width

    png = _generate_placeholder(new_width, new_height)
    return StreamingResponse(io.BytesIO(png), media_type="image/png", headers=SCENE_IMAGE_CACHE_HEADERS)


def _store_scene_image(db: Session, project_id: int, frame_id: int, scene_id: str, body: bytes) -> SceneImage:
    """Normalize `body` to PNG + thumbnail and upsert the scene's snapshot."""
    try:
        with Image.open(io.BytesIO(body)) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")
            width, height = img.size
            png_buffer = io.BytesIO()
            img.save(png_buffer, format="PNG")
            png_buffer.seek(0)
            image_bytes = png_buffer.read()
    except Exception:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not an image")

    thumb, t_width, t_height = _generate_thumbnail(image_bytes)
    now = datetime.utcnow()
    img_row = db.query(SceneImage).filter_by(project_id=project_id, frame_id=frame_id, scene_id=scene_id).first()
    if img_row:
        img_row.image = image_bytes
        img_row.timestamp = now
        img_row.width = width
        img_row.height = height
        img_row.thumb_image = thumb
        img_row.thumb_width = t_width
        img_row.thumb_height = t_height
    else:
        img_row = SceneImage(
            project_id=project_id,
            frame_id=frame_id,
            scene_id=scene_id,
            image=image_bytes,
            timestamp=now,
            width=width,
            height=height,
            thumb_image=thumb,
            thumb_width=t_width,
            thumb_height=t_height,
        )
        db.add(img_row)
    db.commit()
    db.refresh(img_row)
    return img_row


def _frame_or_404(db: Session, project_id: int, frame_id: int) -> Frame:
    frame = db.query(Frame).filter_by(project_id=project_id, id=frame_id).first()
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    return frame


@api_project.post("/frames/{frame_id}/scene_images/{scene_id}", status_code=201)
async def upsert_scene_image(
    frame_id: int,
    scene_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    project_id = current_project_id()
    _frame_or_404(db, project_id, frame_id)

    body = await request.body()
    if not body:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Missing image payload")

    return _store_scene_image(db, project_id, frame_id, scene_id, body).to_dict()


class SceneImageCopyRequest(BaseModel):
    """Where the new scene's cover should come from.

    Exactly one source is used, in this order. Everything resolves on the
    server: the browser never fetches third-party image bytes to re-upload
    them, which it cannot do anyway — the cloud store serves scene covers
    without an `access-control-allow-origin` header, so a cross-origin
    `fetch()` of a store cover is blocked while an `<img>` of it renders fine.
    """

    #: Copy another scene's stored snapshot (duplicate scene). Local, no network.
    source_scene_id: str | None = None
    #: Frame the source scene belongs to; defaults to the target frame.
    source_frame_id: int | None = None
    #: Copy a locally saved template's cover image. Local, no network.
    template_id: str | None = None
    #: A repository template's cover URL. Either a same-origin system
    #: repository path (read off disk) or an absolute URL that must match a
    #: cover URL cached for one of this project's repositories.
    url: str | None = None


def _system_repository_image_bytes(repository_slug: str, template_slug: str) -> bytes:
    # Imported lazily: app/api/__init__ imports these modules in sequence, and
    # this keeps scene_images independent of that order.
    from app.api.repositories import SYSTEM_REPOSITORIES_PATH, _resolve_template_resource

    if any("/" in slug or "\\" in slug or slug in (".", "..") for slug in (repository_slug, template_slug)):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template image not found")

    template_path = SYSTEM_REPOSITORIES_PATH / repository_slug / template_slug
    definition_path = template_path / "template.json"
    if not definition_path.is_file():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template image not found")

    with definition_path.open("r", encoding="utf-8") as template_file:
        template_data = json.load(template_file)

    image_reference = template_data.get("image")
    if not isinstance(image_reference, str) or not image_reference:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template image not found")

    image_path = _resolve_template_resource(template_path, image_reference)
    if not image_path or not image_path.is_file():
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template image not found")

    return image_path.read_bytes()


def repository_template_image_urls(db: Session, project_id: int) -> set[str]:
    """Every cover URL this project's repositories currently advertise.

    This is the allowlist for the outbound fetch below, and it is deliberately
    an exact-URL match rather than a host match: the store's index lives on the
    provider host but serves covers from another (scenes.frameos.net), and a
    host allowlist would turn "add a repository" into "let the backend GET
    anything on that host". Only URLs the picker itself rendered are copyable.
    """
    urls: set[str] = set()
    for repository in db.query(Repository).filter_by(project_id=project_id).all():
        for template in repository.templates or []:
            if isinstance(template, dict) and isinstance(template.get("image"), str):
                urls.add(template["image"])
    return urls


async def _fetch_repository_image(db: Session, project_id: int, url: str) -> bytes:
    system_match = SYSTEM_TEMPLATE_IMAGE_PATH.match(url)
    if system_match:
        return _system_repository_image_bytes(system_match.group(1), system_match.group(2))

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or not is_safe_host(parsed.hostname):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Unsupported image URL")

    if url not in repository_template_image_urls(db, project_id):
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Image URL does not belong to a known repository",
        )

    from app.utils.cloud_backup import cloud_headers_for_url

    try:
        # No redirect following: the allowlist covers the URL we were given,
        # not wherever it might bounce us (link-local metadata services and
        # friends).
        async with httpx.AsyncClient(follow_redirects=False) as client:
            response = await client.get(
                url,
                headers=cloud_headers_for_url(db, url),
                timeout=COPIED_IMAGE_TIMEOUT_SECONDS,
            )
    except Exception as exc:  # noqa: BLE001 — the repository host is out of our control
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not fetch the image: {exc}") from exc

    if response.status_code != 200:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Could not fetch the image: unexpected status {response.status_code}",
        )

    content = response.content
    if len(content) > MAX_COPIED_IMAGE_BYTES:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Image is too large")
    return content


@api_project.post("/frames/{frame_id}/scene_images/{scene_id}/copy", status_code=201)
async def copy_scene_image(
    frame_id: int,
    scene_id: str,
    data: SceneImageCopyRequest,
    db: Session = Depends(get_db),
):
    """Give a freshly added scene a cover without routing the bytes through
    the browser — see SceneImageCopyRequest for the sources."""
    project_id = current_project_id()
    _frame_or_404(db, project_id, frame_id)

    if data.source_scene_id:
        source_row = (
            db.query(SceneImage)
            .filter_by(
                project_id=project_id,
                frame_id=data.source_frame_id or frame_id,
                scene_id=data.source_scene_id,
            )
            .order_by(SceneImage.timestamp.desc())
            .first()
        )
        if source_row is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Source scene has no image")
        image_bytes = source_row.image
    elif data.template_id:
        template = db.query(Template).filter_by(project_id=project_id, id=data.template_id).first()
        if template is None or not template.image:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Template image not found")
        image_bytes = template.image
    elif data.url:
        image_bytes = await _fetch_repository_image(db, project_id, data.url)
    else:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Provide source_scene_id, template_id or url",
        )

    return _store_scene_image(db, project_id, frame_id, scene_id, image_bytes).to_dict()
