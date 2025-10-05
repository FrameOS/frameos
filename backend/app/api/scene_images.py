import io
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

    if frame.width is None or frame.height is None:
        new_width, new_height = 320, 240
    elif request.query_params.get("thumb") == "1":
        scale = min(320 / frame.width, 320 / frame.height, 1.0)
        new_width  = int(round(frame.width  * scale))
        new_height = int(round(frame.height * scale))
    else:
        new_width  = frame.width
        new_height = frame.height

    if frame.rotate == 90 or frame.rotate == 270:
        new_width, new_height = new_height, new_width

    png = _generate_placeholder(new_width, new_height)
    return StreamingResponse(io.BytesIO(png), media_type="image/png")
