"""The frame's `dither` setting and the OpenDisplay packer path.

A palette panel (Spectra 6, 7-colour, BWYR) the control plane packs for (a
thin client, a frame that renders on the server, a virtual frame) is dithered
with Floyd–Steinberg by default (`_dithered_indices` in api/embedded_device.py).
A frame can choose OpenDisplay epaper-dithering instead
(https://github.com/OpenDisplay/epaper-dithering, MIT): ink matching in OKLab,
error diffusion with a serpentine scan, a linear-light exposure, and an
optional Direct Binary Search pass that refines the result for a viewing
distance. The cloud runs the same Rust core through its WASM build, so both
planes produce the same bytes (docs/dither-fixtures.json pins it).

The setting is the plane's own: it never reaches the device, which only ever
receives the packed picture.
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any

logger = logging.getLogger(__name__)

METHOD_FLOYD_STEINBERG = "floydSteinberg"
METHOD_OPENDISPLAY = "opendisplay"
METHODS = (METHOD_FLOYD_STEINBERG, METHOD_OPENDISPLAY)
# OpenDisplay's error-diffusion kernels (DitherMode), by its own names.
ALGORITHMS = (
    "burkes",
    "floyd_steinberg",
    "atkinson",
    "stucki",
    "sierra",
    "sierra_lite",
    "jarvis_judice_ninke",
    "ordered",
)
DEFAULT_ALGORITHM = "burkes"
EXPOSURE_RANGE = (0.5, 2.0)
VIEWING_DISTANCE_RANGE_CM = (10.0, 500.0)
DEFAULT_VIEWING_DISTANCE_CM = 30.0
# Pixel density when the panel's size is not known (a 7.3" 800x480 panel).
DEFAULT_PPI = 127.0
# An owner's override of the density read from the panel's name.
PPI_RANGE = (50.0, 600.0)
# OpenDisplay's tone and colour steps, run in this order before the inks are
# matched: saturation (OKLab chroma multiplier, 1 = unchanged), shadows (lift)
# and highlights (compression), tone (black-point lift onto the panel's own
# range) and gamut (pull colours the panel cannot show towards ones it can).
# Each is a no-op at its default.
ADJUSTMENTS: dict[str, tuple[float, float, float]] = {
    "saturation": (0.0, 2.0, 1.0),
    "shadows": (0.0, 1.0, 0.0),
    "highlights": (0.0, 1.0, 0.0),
    "tone": (0.0, 1.0, 0.0),
    "gamut": (0.0, 1.0, 0.0),
}
# What a saved preset list may hold (the `ditherPresets` settings group).
MAX_PRESETS = 50
MAX_PRESET_NAME = 60
# DBS on a 13.3" panel (1.9 M pixels) is about 4 s on a fast laptop; above
# this the pass is skipped and the picture keeps the plain error diffusion.
DBS_MAX_PIXELS = 2_000_000

# Ink of each wire index, per stock palette length (Spectra 6 keeps its hole
# at index 4, which is never dithered to).
_INKS_BY_TABLE: dict[int, dict[str, list[str | None]]] = {
    7: {
        "spectra6": ["black", "white", "yellow", "red", None, "blue", "green"],
        "sevenColor": ["black", "white", "green", "blue", "red", "yellow", "orange"],
    },
    4: {"bwyr": ["black", "white", "yellow", "red"]},
}
_NOMINAL = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "yellow": (255, 255, 0),
    "red": (255, 0, 0),
    "blue": (0, 0, 255),
    "green": (0, 255, 0),
    "orange": (255, 128, 0),
}

_failed_once = False


def normalize_dither(value: Any) -> dict | None:
    """The stored setting as the packer reads it: None for the default
    (Floyd–Steinberg) or anything unreadable; otherwise every field filled in
    and clamped. Also what the render fingerprint names."""
    if not isinstance(value, dict) or value.get("method") != METHOD_OPENDISPLAY:
        return None
    algorithm = value.get("algorithm")
    exposure = value.get("exposure")
    distance = value.get("viewingDistanceCm")
    ppi = value.get("ppi")
    normalized = {
        "method": METHOD_OPENDISPLAY,
        "algorithm": algorithm if algorithm in ALGORITHMS else DEFAULT_ALGORITHM,
        "dbs": value.get("dbs") is True,
        "exposure": _clamp(exposure, *EXPOSURE_RANGE, 1.0),
        "viewingDistanceCm": _clamp(distance, *VIEWING_DISTANCE_RANGE_CM, DEFAULT_VIEWING_DISTANCE_CM),
    }
    for key, (low, high, default) in ADJUSTMENTS.items():
        normalized[key] = _clamp(value.get(key), low, high, default)
    normalized["ppi"] = None if ppi is None else _clamp(ppi, *PPI_RANGE, DEFAULT_PPI)
    return normalized


def validate_dither(value: Any) -> dict | None:
    """The API's check: None (clear it), or a dict whose every given field is
    in range. Raises ValueError with the reason otherwise."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("dither must be an object")
    allowed = {"method", "algorithm", "dbs", "exposure", "viewingDistanceCm", "ppi", *ADJUSTMENTS}
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"unknown dither keys: {', '.join(sorted(unknown))}")
    if value.get("method", METHOD_FLOYD_STEINBERG) not in METHODS:
        raise ValueError(f"dither.method must be one of {', '.join(METHODS)}")
    if "algorithm" in value and value["algorithm"] not in ALGORITHMS:
        raise ValueError(f"dither.algorithm must be one of {', '.join(ALGORITHMS)}")
    if "dbs" in value and not isinstance(value["dbs"], bool):
        raise ValueError("dither.dbs must be true or false")
    ranges = {
        "exposure": EXPOSURE_RANGE,
        "viewingDistanceCm": VIEWING_DISTANCE_RANGE_CM,
        "ppi": PPI_RANGE,
        **{key: (low, high) for key, (low, high, _default) in ADJUSTMENTS.items()},
    }
    for key, (low, high) in ranges.items():
        if key == "ppi" and value.get("ppi") is None:
            continue
        if key in value:
            number = value[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not low <= number <= high:
                raise ValueError(f"dither.{key} must be a number from {low:g} to {high:g}")
    return dict(value)


def validate_dither_presets(value: Any) -> list[dict] | None:
    """The `ditherPresets` settings group: None, or a list of at most
    MAX_PRESETS `{id, name, dither}` entries, each `dither` passing
    validate_dither and not None. Raises ValueError with the reason."""
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("ditherPresets must be a list")
    if len(value) > MAX_PRESETS:
        raise ValueError(f"at most {MAX_PRESETS} dithering presets")
    presets: list[dict] = []
    seen: set[str] = set()
    for preset in value:
        if not isinstance(preset, dict) or set(preset) - {"id", "name", "dither"}:
            raise ValueError("a dithering preset is {id, name, dither}")
        preset_id, name = preset.get("id"), preset.get("name")
        if not isinstance(preset_id, str) or not 0 < len(preset_id) <= 64 or preset_id in seen:
            raise ValueError("a dithering preset needs a unique id")
        if not isinstance(name, str) or not 0 < len(name.strip()) <= MAX_PRESET_NAME:
            raise ValueError(f"a dithering preset needs a name of 1 to {MAX_PRESET_NAME} characters")
        dither = validate_dither(preset.get("dither"))
        if dither is None:
            raise ValueError("a dithering preset needs its dither settings")
        seen.add(preset_id)
        presets.append({"id": preset_id, "name": name.strip(), "dither": dither})
    return presets


def panel_ppi(panel: str | None, width: int, height: int) -> float:
    """Pixel density from the panel's name, which carries its diagonal
    (`EPD_7in3e` = 7.3", `EPD_13in3e` = 13.3", `inky_impression_4` = 4"),
    else DEFAULT_PPI."""
    diagonal = panel_diagonal_inches(panel)
    if not diagonal or width <= 0 or height <= 0:
        return DEFAULT_PPI
    return math.hypot(width, height) / diagonal


def panel_diagonal_inches(panel: str | None) -> float | None:
    if not panel:
        return None
    name = panel.rsplit(".", 1)[-1]
    match = re.search(r"(\d+)in(\d)", name)
    if match:
        return float(f"{match.group(1)}.{match.group(2)}")
    match = re.search(r"impression_(\d+(?:\.\d+)?)", name)
    if match:
        return float(match.group(1))
    return None


def inks_for_palette(palette: list[tuple[int, int, int]]) -> list[str | None] | None:
    """The ink name of each wire index of a stock-shaped palette, None where
    an index is not an ink (the Spectra 6 hole). None for an unknown shape."""
    tables = _INKS_BY_TABLE.get(len(palette))
    if not tables:
        return None
    if len(palette) == 7:
        hole = max(palette[4]) > 255
        return tables["spectra6" if hole else "sevenColor"]
    return tables["bwyr"]


def opendisplay_indices(image, palette: list[tuple[int, int, int]], dither: dict, ppi: float) -> bytes | None:
    """One wire index per pixel, dithered by OpenDisplay to ``palette`` (the
    frame's resolved palette, stock-shaped). None when the package or the
    palette shape is missing, or the call fails: the caller then packs with
    Floyd–Steinberg, so a frame always gets a picture."""
    global _failed_once
    inks = inks_for_palette(palette)
    if inks is None:
        return None
    try:
        import epaper_dithering as ed

        wire: list[int] = []
        entries: list[tuple[tuple[int, int, int], str | None, tuple[int, int, int]]] = []
        for index, ink in enumerate(inks):
            if ink is None:
                continue
            red, green, blue = palette[index]
            wire.append(index)
            entries.append(((red, green, blue), ink, _NOMINAL[ink]))
        od_palette = ed.Palette.from_srgb(entries, measured=True)
        use_dbs = dither["dbs"] and image.width * image.height <= DBS_MAX_PIXELS
        ppi = dither.get("ppi") or ppi
        options = ed.DitherOptions(
            mode=dither["algorithm"],
            exposure=dither["exposure"],
            dbs=ed.DbsParams(viewing_distance_cm=dither["viewingDistanceCm"], ppi=ppi) if use_dbs else None,
            **{key: dither.get(key, default) for key, (_low, _high, default) in ADJUSTMENTS.items()},
        )
        result = ed.dither_image(image.convert("RGB"), od_palette, options)
        # A palette-mode image: one byte per pixel, an index into `entries`.
        table = bytes(wire[value] if value < len(wire) else 0 for value in range(256))
        return result.tobytes().translate(table)
    except Exception:
        if not _failed_once:
            logger.warning("server_render.dither_fallback: OpenDisplay dithering failed, using Floyd-Steinberg",
                           exc_info=True)
            _failed_once = True
        return None


def _clamp(value: Any, low: float, high: float, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
        return default
    return float(min(high, max(low, value)))
