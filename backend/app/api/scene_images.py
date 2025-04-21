# backend/app/api/scene_images.py
import io
from typing import Optional
from jose import JWTError, jwt

from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy.orm import Session
from app.api.auth import ALGORITHM, SECRET_KEY

from app.config import config
from app.database import get_db
from app.models.scene_image import SceneImage            # created earlier
from app.models.frame import Frame
from . import api_no_auth


def _generate_placeholder(width: Optional[int], height: Optional[int]) -> bytes:
    """
    Produce a PNG with given width/height (defaults applied) that shows
    a black background and centred 'No snapshot taken' white text.
    """
    width = int(width or 400)
    height = int(height or 300)

    img = Image.new("RGB", (width, height), "black")
    draw = ImageDraw.Draw(img)

    # Pillow’s built‑in bitmap font keeps things dependency‑free
    font = ImageFont.load_default()
    text = "No snapshot taken"
    tw, th = draw.textsize(text, font=font)
    draw.text(((width - tw) / 2, (height - th) / 2), text, fill="white", font=font)

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

        img = img.resize((new_width, new_height), Image.ANTIALIAS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        return buf.read(), new_width, new_height


@api_no_auth.get("/frames/{frame_id}/scene_images/{scene_id}")
async def get_scene_image(
    frame_id: int,
    scene_id: str,
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Fetch the latest stored SceneImage.
    If none exists, return a placeholder that matches the frame’s native
    width/height so the UI keeps its layout.
    """

    if config.HASSIO_RUN_MODE != 'ingress':
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("sub") != f"frame={frame_id}":
                raise HTTPException(status_code=401, detail="Unauthorized")
        except JWTError:
            raise HTTPException(status_code=401, detail="Unauthorized")


    img_row: SceneImage | None = (
        db.query(SceneImage)
        .filter_by(frame_id=frame_id, scene_id=scene_id)
        .order_by(SceneImage.timestamp.desc())
        .first()
    )

    if img_row:
        # fresh snapshot found, generate and save thumbnail if not present
        if not getattr(img_row, 'thumb_image', None):
            thumb, t_width, t_height = _generate_thumbnail(img_row.image)
            img_row.thumb_image = thumb
            img_row.thumb_width = t_width
            img_row.thumb_height = t_height
            db.add(img_row)
            db.commit()
            db.refresh(img_row)
        if request.query_params.get("thumb") == "1":
            return StreamingResponse(
                io.BytesIO(img_row.thumb_image),
                media_type="image/jpeg",
                headers={"Cache-Control": "no-cache"},
            )
        else:
            return StreamingResponse(
                io.BytesIO(img_row.image),
                media_type="image/png",
                headers={"Cache-Control": "no-cache"},
            )

    frame: Frame | None = db.get(Frame, frame_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")

    png = _generate_placeholder(frame.width, frame.height)
    # NB: we do *not* persist this placeholder – it’s cheaper to regenerate.
    return StreamingResponse(io.BytesIO(png), media_type="image/png")
