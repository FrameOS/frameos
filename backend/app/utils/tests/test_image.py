import io

import pytest
from PIL import Image

from app.utils.image import THUMBNAIL_MAX_EDGE, render_thumbnail_png


def _png_bytes(width: int, height: int, mode: str = "RGB") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (width, height), color=(10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_render_thumbnail_png_fits_inside_the_box_and_keeps_aspect():
    thumbnail = render_thumbnail_png(_png_bytes(1600, 900))

    with Image.open(io.BytesIO(thumbnail)) as image:
        assert image.format == "PNG"
        assert max(image.size) <= THUMBNAIL_MAX_EDGE
        # 16:9 in, 16:9 out — fit, never crop.
        assert image.size == (320, 180)


def test_render_thumbnail_png_never_upscales():
    thumbnail = render_thumbnail_png(_png_bytes(64, 48))

    with Image.open(io.BytesIO(thumbnail)) as image:
        assert image.size == (64, 48)


def test_render_thumbnail_png_keeps_transparency():
    thumbnail = render_thumbnail_png(_png_bytes(800, 800, mode="RGBA"))

    with Image.open(io.BytesIO(thumbnail)) as image:
        assert image.mode == "RGBA"


def test_render_thumbnail_png_raises_on_undecodable_bytes():
    with pytest.raises(Exception):
        render_thumbnail_png(b"not an image at all")
