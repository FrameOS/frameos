import io
from PIL import Image, ImageDraw, ImageFont

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
