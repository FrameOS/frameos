# backend/app/api/scene_images.py
import io
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.scene_image import SceneImage            # created earlier
from app.models.frame import Frame
from . import api_with_auth


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


@api_with_auth.get("/frames/{frame_id}/scene_images/{scene_id}")
async def get_scene_image(
    frame_id: int,
    scene_id: str,
    db: Session = Depends(get_db),
):
    """
    Fetch the latest stored SceneImage.
    If none exists, return a placeholder that matches the frame’s native
    width/height so the UI keeps its layout.
    """
    img_row: SceneImage | None = (
        db.query(SceneImage)
        .filter_by(frame_id=frame_id, scene_id=scene_id)
        .order_by(SceneImage.timestamp.desc())
        .first()
    )

    if img_row:
        # fresh snapshot found
        return StreamingResponse(
            io.BytesIO(img_row.image),
            media_type="image/png",
            headers={"Cache-Control": "no-cache"},
        )

    # ───── No snapshot: create placeholder ─────
    frame: Frame | None = db.get(Frame, frame_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")

    png = _generate_placeholder(frame.width, frame.height)
    # NB: we do *not* persist this placeholder – it’s cheaper to regenerate.
    return StreamingResponse(io.BytesIO(png), media_type="image/png")
