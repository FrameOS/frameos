import io
from PIL import Image, ImageDraw, ImageFont

# Asset thumbnails, kept in step with the device runtime
# (frameos/src/frameos/server/routes/admin_api_assets_routes.nim): a frame
# caches them under .thumbs/<md5><suffix> and serves them with this type.
# PNG rather than JPEG because the frame encodes with Pixie, which reads a
# dozen formats and writes no JPEG.
THUMBNAIL_MAX_EDGE = 320
THUMBNAIL_FILE_SUFFIX = ".320x320.png"
THUMBNAIL_CONTENT_TYPE = "image/png"


def render_thumbnail_png(data: bytes, max_edge: int = THUMBNAIL_MAX_EDGE) -> bytes:
    """Fit an image inside a max_edge box and encode it as PNG.

    Fit, never crop, and never upscale — the same shape as the frame's own
    thumbnailer, so a preview looks the same whichever side produced it.
    """
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.thumbnail((max_edge, max_edge), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, format="PNG")
    return out.getvalue()


def render_line_of_text_png(text: str, width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height), color=(31, 41, 55))
    draw = ImageDraw.Draw(image)

    margin = int(min(width, height) * 0.2)
    max_w = width - 2 * margin
    max_h = height - 2 * margin

    # Try to load a nice scalable TTF; fall back to PIL default if needed
    def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # common on linux
            "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
            "/Library/Fonts/Arial.ttf",  # mac
            "arial.ttf",  # windows / sometimes present
        ]
        for path in candidates:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
        return ImageFont.load_default()

    # Helper: measure text size reliably
    def _measure(font):
        try:
            bbox = draw.textbbox((0, 0), text, font=font)
            return bbox[2] - bbox[0], bbox[3] - bbox[1]
        except Exception:
            return draw.textsize(text, font=font)

    # Binary search the largest font size that fits within max_w x max_h
    lo, hi = 1, max(1, int(max_h * 0.9))  # upper bound based on height
    best_font, best_sz = None, 1
    while lo <= hi:
        mid = (lo + hi) // 2
        font = _load_font(mid)
        tw, th = _measure(font)
        if tw <= max_w and th <= max_h:
            best_font, best_sz = font, mid
            lo = mid + 1
        else:
            hi = mid - 1

    # If TTF loading completely failed, best_font may be default; re-measure
    if best_font is None:
        best_font = _load_font(best_sz)

    tw, th = _measure(best_font)
    x = (width - tw) // 2
    y = (height - th) // 2

    # Gray text on black, single line, centered, no wrapping
    draw.text((x, y), text, font=best_font, fill=(120, 120, 120))

    body_io = io.BytesIO()
    image.save(body_io, format="PNG")
    body_io.seek(0)
    body = body_io.read()
    return body
