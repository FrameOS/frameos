"""The frame's `dither` setting and the OpenDisplay packer path
(app/utils/panel_dither.py, pack_image_for_panel)."""

import json
import os
import random
from pathlib import Path

import pytest
from PIL import Image

from app.api.embedded_device import (
    BWYR_PALETTE,
    SEVEN_COLOR_PALETTE,
    SPECTRA6_PALETTE,
    pack_image_for_panel,
)
from app.tasks.embedded_firmware import FOS_PIXEL_2BPP_BWYR, FOS_PIXEL_4BPP_7COLOR, FOS_PIXEL_4BPP_SPECTRA6
from app.utils import panel_dither
from app.utils.panel_dither import (
    DEFAULT_PPI,
    normalize_dither,
    panel_diagonal_inches,
    panel_ppi,
    validate_dither,
    validate_dither_presets,
)

DITHER_FIXTURES = Path(__file__).resolve().parents[4] / "docs" / "dither-fixtures.json"
# Measured on a real Inky Impression 4.0" (Spectra 6): docs/dithering.md.
MEASURED_SPECTRA6 = [(33, 19, 45), (176, 186, 187), (187, 170, 53), (126, 6, 15), (999, 999, 999),
                     (56, 105, 158), (87, 123, 95)]


def _image(width: int, height: int, seed: int) -> Image.Image:
    """A small deterministic picture: a hue/brightness ramp with noise."""
    rng = random.Random(seed)
    data = bytearray()
    for y in range(height):
        for x in range(width):
            base = (x * 255 // max(1, width - 1), y * 255 // max(1, height - 1), (x + y) * 127 // max(1, width + height))
            data.extend(max(0, min(255, c + rng.randint(-24, 24))) for c in base)
    return Image.frombytes("RGB", (width, height), bytes(data))


def _cases():
    """(name, pixel format, palette, dither, ppi, image)."""
    opendisplay = normalize_dither({"method": "opendisplay"})
    measured = normalize_dither({"method": "opendisplay", "dbs": True, "exposure": 1.3, "viewingDistanceCm": 30})
    yield "spectra6 stock, burkes", FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE, opendisplay, DEFAULT_PPI, _image(16, 12, 1)
    yield ("spectra6 measured, dbs, exposure 1.3", FOS_PIXEL_4BPP_SPECTRA6, MEASURED_SPECTRA6, measured, 180.0,
           _image(16, 12, 2))
    yield ("spectra6 stock, atkinson", FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE,
           normalize_dither({"method": "opendisplay", "algorithm": "atkinson"}), DEFAULT_PPI, _image(15, 9, 3))
    yield "7-colour stock, burkes", FOS_PIXEL_4BPP_7COLOR, SEVEN_COLOR_PALETTE, opendisplay, DEFAULT_PPI, _image(16, 12, 4)
    yield "bwyr stock, dbs", FOS_PIXEL_2BPP_BWYR, BWYR_PALETTE, normalize_dither({"method": "opendisplay", "dbs": True}), \
        DEFAULT_PPI, _image(16, 12, 5)
    tuned = normalize_dither({"method": "opendisplay", "dbs": True, "exposure": 1.2, "saturation": 1.3, "shadows": 0.4,
                              "highlights": 0.3, "tone": 0.2, "gamut": 0.5, "ppi": 200})
    yield "spectra6 measured, fine tuned, ppi override", FOS_PIXEL_4BPP_SPECTRA6, MEASURED_SPECTRA6, tuned, DEFAULT_PPI, \
        _image(16, 12, 6)


def _hex(colors):
    return [None if max(c) > 255 else "#%02x%02x%02x" % c for c in colors]


def test_the_dither_corpus():
    """Both planes dither the same: the cloud runs the same Rust core through
    its WASM build and replays these cases (cloud/apps/auth-web/src/lib/
    panel-dither.test.ts). WRITE_DITHER_FIXTURES=1 rewrites the file."""
    cases = []
    for name, pixel_format, palette, dither, ppi, image in _cases():
        # The case really runs OpenDisplay (the fallback would record Floyd-Steinberg).
        assert panel_dither.opendisplay_indices(image, palette, dither, ppi) is not None, name
        packed = pack_image_for_panel(image, pixel_format, palette, dither, ppi)
        # Deterministic: the ETag of an unchanged picture must not move.
        assert pack_image_for_panel(image, pixel_format, palette, dither, ppi) == packed, name
        cases.append({
            "name": name,
            "pixelFormat": pixel_format,
            "width": image.width,
            "height": image.height,
            "rgb": image.tobytes().hex(),
            "palette": _hex(palette),
            "dither": dither,
            "ppi": ppi,
            "packed": packed.hex(),
        })
    corpus = {
        "comment": (
            "OpenDisplay dithering on the packing planes (docs/dithering.md): per case a small RGB "
            "picture, the stock-shaped palette it is dithered to (null = Spectra 6's unused index 4), "
            "the frame's normalized `dither`, the panel's pixel density and the packed panel bytes "
            "(hex). Written by backend/app/utils/tests/test_panel_dither.py (WRITE_DITHER_FIXTURES=1), "
            "replayed by it and by cloud/apps/auth-web/src/lib/panel-dither.test.ts."
        ),
        "package": "epaper-dithering 7.0.1",
        "cases": cases,
    }
    if os.environ.get("WRITE_DITHER_FIXTURES") == "1":
        DITHER_FIXTURES.write_text(json.dumps(corpus, indent=2) + "\n")
    assert json.loads(DITHER_FIXTURES.read_text()) == corpus


def test_floyd_steinberg_is_the_default():
    image = _image(16, 12, 9)
    fs = pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE)
    assert pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE, None) == fs
    assert pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE,
                                normalize_dither({"method": "opendisplay"})) != fs


def test_never_the_spectra_hole():
    image = _image(32, 24, 11)
    packed = pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE,
                                  normalize_dither({"method": "opendisplay", "dbs": True}))
    nibbles = {value for byte in packed for value in (byte >> 4, byte & 15)}
    assert 4 not in nibbles
    assert nibbles <= {0, 1, 2, 3, 5, 6}


def test_falls_back_to_floyd_steinberg(monkeypatch):
    image = _image(16, 12, 12)
    fs = pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE)

    def broken(*args, **kwargs):
        raise RuntimeError("no core")

    import epaper_dithering

    monkeypatch.setattr(epaper_dithering, "dither_image", broken)
    monkeypatch.setattr(panel_dither, "_failed_once", False)
    assert pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6, SPECTRA6_PALETTE,
                                normalize_dither({"method": "opendisplay"})) == fs


def test_normalize_fills_in_and_clamps():
    assert normalize_dither(None) is None
    assert normalize_dither({"method": "floydSteinberg", "dbs": True}) is None
    assert normalize_dither({"method": "opendisplay"}) == {
        "method": "opendisplay", "algorithm": "burkes", "dbs": False, "exposure": 1.0, "viewingDistanceCm": 30.0,
        "saturation": 1.0, "shadows": 0.0, "highlights": 0.0, "tone": 0.0, "gamut": 0.0, "ppi": None,
    }
    assert normalize_dither({"method": "opendisplay", "algorithm": "nope", "exposure": 9, "viewingDistanceCm": True,
                             "saturation": 5, "tone": -1, "ppi": 10}) == {
        "method": "opendisplay", "algorithm": "burkes", "dbs": False, "exposure": 2.0, "viewingDistanceCm": 30.0,
        "saturation": 2.0, "shadows": 0.0, "highlights": 0.0, "tone": 0.0, "gamut": 0.0, "ppi": 50.0,
    }


@pytest.mark.parametrize("value", [
    {"method": "dbs"},
    {"method": "opendisplay", "algorithm": "fancy"},
    {"method": "opendisplay", "dbs": "yes"},
    {"method": "opendisplay", "exposure": 3},
    {"method": "opendisplay", "viewingDistanceCm": 2},
    {"method": "opendisplay", "colour": "red"},
    {"method": "opendisplay", "saturation": 2.5},
    {"method": "opendisplay", "gamut": -0.1},
    {"method": "opendisplay", "ppi": 20},
    {"method": "opendisplay", "tone": "a bit"},
    ["opendisplay"],
])
def test_validate_refuses(value):
    with pytest.raises(ValueError):
        validate_dither(value)


def test_validate_accepts():
    assert validate_dither(None) is None
    value = {"method": "opendisplay", "algorithm": "stucki", "dbs": True, "exposure": 1.3, "viewingDistanceCm": 80}
    assert validate_dither(value) == value
    tuned = {"method": "opendisplay", "saturation": 0.0, "shadows": 1, "highlights": 0.5, "tone": 0.2, "gamut": 1,
             "ppi": None}
    assert validate_dither(tuned) == tuned
    assert validate_dither({"method": "opendisplay", "ppi": 180}) == {"method": "opendisplay", "ppi": 180}


def test_each_adjustment_changes_the_picture():
    """Every fine-tuning setting really reaches OpenDisplay. Saturated hues,
    so gamut compression has colours outside the panel's range to pull in."""
    import colorsys

    image = Image.new("RGB", (24, 16))
    image.putdata([tuple(int(c * 255) for c in colorsys.hsv_to_rgb(x / 24, 1, 0.6 + 0.4 * y / 16))
                   for y in range(16) for x in range(24)])
    base = normalize_dither({"method": "opendisplay"})
    plain = panel_dither.opendisplay_indices(image, MEASURED_SPECTRA6, base, DEFAULT_PPI)
    for key, value in (("saturation", 0.2), ("shadows", 1.0), ("highlights", 1.0), ("tone", 1.0), ("gamut", 1.0)):
        tuned = panel_dither.opendisplay_indices(image, MEASURED_SPECTRA6, {**base, key: value}, DEFAULT_PPI)
        assert tuned is not None and tuned != plain, key
    dbs = {**base, "dbs": True}
    assert (panel_dither.opendisplay_indices(image, MEASURED_SPECTRA6, {**dbs, "ppi": 60.0}, DEFAULT_PPI)
            != panel_dither.opendisplay_indices(image, MEASURED_SPECTRA6, dbs, DEFAULT_PPI))


def test_presets():
    preset = {"id": "p1", "name": " Photo ", "dither": {"method": "opendisplay", "exposure": 1.3}}
    assert validate_dither_presets(None) is None
    assert validate_dither_presets([]) == []
    assert validate_dither_presets([preset]) == [{**preset, "name": "Photo"}]
    for bad in (
        "photo",
        [{"id": "p1", "name": "x"}],
        [{"id": "p1", "name": "", "dither": {"method": "opendisplay"}}],
        [{"id": "p1", "name": "x" * 61, "dither": {"method": "opendisplay"}}],
        [{"id": "p1", "name": "x", "dither": {"method": "opendisplay", "exposure": 9}}],
        [{"id": "p1", "name": "x", "dither": {"method": "opendisplay"}, "colour": "red"}],
        [preset, preset],
        [{**preset, "id": f"p{i}"} for i in range(51)],
    ):
        with pytest.raises(ValueError):
            validate_dither_presets(bad)


def test_panel_density_from_the_name():
    assert panel_diagonal_inches("EPD_7in3e") == 7.3
    assert panel_diagonal_inches("waveshare.EPD_13in3e") == 13.3
    assert panel_diagonal_inches("EPD_4in0e") == 4.0
    assert panel_diagonal_inches("pimoroni.inky_impression_4") == 4.0
    assert panel_diagonal_inches("embedded") is None
    assert round(panel_ppi("EPD_7in3e", 800, 480)) == 128
    assert round(panel_ppi("EPD_4in0e", 600, 400)) == 180
    assert panel_ppi(None, 800, 480) == DEFAULT_PPI
