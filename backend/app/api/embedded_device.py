"""Device-facing endpoints for embedded (ESP32) frames.

The microcontroller authenticates with its ``server_api_key`` as a Bearer
token (same scheme as ``/api/log``). Device endpoints:

- ``GET /api/frames/{id}/embedded/render`` — the thin-client bitmap in the
  panel's wire format. When the frame has scenes and the wasm scene runtime
  is available (node + the emscripten bundle, see
  ``app/utils/embedded_render.py``), the active scene renders server-side,
  sandboxed inside wasm, its HTTP going through the harness's guarded fetch
  (``scene_network_policy``). Otherwise (or on any render failure) a
  diagnostic card is served so the device always gets a frame. A board with
  PSRAM renders on-device unless it is set to render on the server
  (``device_config.renderMode``, docs/server-rendering.md).
- ``GET /api/frames/{id}/embedded/ota/manifest?platform=…`` — the latest
  FrameOS release's OTA manifest for the device's flash layout, relayed from
  the GitHub release (version, size, minisign signature, download URL); the
  same shape the cloud serves. The backend holds no signing key: the device
  verifies the image against the release key baked into every firmware.
- ``GET /api/frames/{id}/embedded/ota/download?platform=…`` — the release's
  bare OTA app image (``…-app.bin``, not the merged flash image), proxied.
- ``GET /api/frames/{id}/embedded/settings`` — live frame settings the
  device polls (interval, name, power, rotation, time zone, the frame's own
  HTTPS certificate and key, admin login, service API keys, schedule).
- ``GET /api/frames/{id}/embedded/scenes`` — the frame's scenes as a JSON
  array (interpreted scenes: QuickJS + AOT app library on-device). The
  ETag is the payload's sha256; devices poll with ``If-None-Match`` and get
  304 when nothing changed, so hot scene updates need no reflash.
- ``POST /api/frames/{id}/embedded/image?scene_id=…`` — the image the panel
  shows, pushed after a render (in ``frames.py``, next to the image cache it
  fills and the ``GET …/image`` route that then serves it instead of pulling).

Wire format for /render ("FOSB"): magic ``FOSB``, version u8 (1), pixel
format u8 (see ``fos_pixel_format_t``), width u16le, height u16le, reserved
u16, then the packed payload bytes for that format. The response carries an
``ETag`` (the first 32 hex digits of the body's sha256) and answers a pull
whose ``If-None-Match`` names it with 304: the panel already shows it
(docs/server-rendering.md "The render pull").
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus

from fastapi import Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.utils.tz_slice import tz_slice
from app.utils.retired_apps import frame_runtime_version, scenes_for_embedded_runtime
from app.database import get_db
from app.drivers.devices import device_dimensions
from app.models.frame import (
    Frame,
    get_frame_json,
    normalize_event_map,
    normalize_frame_admin_auth,
    normalize_https_proxy,
    shipped_frame_settings,
)
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.utils.embedded_render import RenderQueueFull, render_scene_rgba_and_state
from app.utils.events_contract_gen import BUILT_IN_SCENE_IDS
from app.utils.frame_commands import pending_command_types, previewed_scenes
from app.utils.server_render import (
    PRERENDER_MAX_SKEW_SECONDS,
    bump_render_revision,
    epoch_ms,
    etag_matches,
    fosb_etag,
    keep_prerender,
    prerender_as_of,
    prerender_usable,
    remember_render_ms,
    render_fingerprint,
    render_revision,
    take_prerender,
)
from app.api.firmware_release import latest_release_ota_manifest, stream_latest_release_ota_image
from app.tasks.embedded_firmware import (
    EMBEDDED_IMAGE_FORMAT_BIN,
    FOS_PIXEL_1BPP,
    FOS_PIXEL_2BPP_BWYR,
    FOS_PIXEL_2BPP_GRAY,
    FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_GRAY,
    FOS_PIXEL_4BPP_SPECTRA6,
    FOS_PIXEL_DUAL_1BPP_RED,
    FOS_PIXEL_DUAL_1BPP_YELLOW,
    FOS_PIXEL_RGB565,
    embedded_buffer_size,
    embedded_max_http_response_bytes_for_frame,
    embedded_panel_for_frame,
    embedded_pixel_format_for_panel,
    embedded_release_firmware_for_frame,
    embedded_render_scale_for_frame,
    embedded_scaling_mode_for_frame,
)
from . import api_public

DEFAULT_WIDTH = 800
DEFAULT_HEIGHT = 480

BWYR_PALETTE = [
    (57, 48, 57),
    (255, 255, 255),
    (208, 190, 71),
    (156, 72, 75),
]
SPECTRA6_PALETTE = [
    (25, 20, 38),
    (178, 193, 192),
    (199, 187, 0),
    (107, 17, 25),
    (999, 999, 999),
    (24, 83, 154),
    (42, 85, 49),
]
SEVEN_COLOR_PALETTE = [
    (57, 48, 57),
    (255, 255, 255),
    (58, 91, 70),
    (61, 59, 94),
    (156, 72, 75),
    (208, 190, 71),
    (177, 106, 73),
]


def _embedded_frame_from_bearer(db: Session, frame_id: int, authorization: str | None) -> Frame:
    if not authorization:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Invalid Authorization header")
    frame = db.query(Frame).filter_by(server_api_key=parts[1]).first()
    if not frame or int(frame.id) != frame_id:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    if (frame.mode or "rpios") != "embedded":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not an embedded frame")
    return frame


def embedded_render_dimensions(frame: Frame) -> tuple[int, int]:
    dims = device_dimensions(frame.device)
    if dims:
        return dims
    if frame.width and frame.height:
        return int(frame.width), int(frame.height)
    return DEFAULT_WIDTH, DEFAULT_HEIGHT


def _dithered_indices(image, palette: list[tuple[int, int, int]]) -> bytes:
    """One palette index per pixel, Floyd-Steinberg dithered.

    The on-device renderers dither before packing (``ditherPaletteIndexed`` in
    frameos/src/frameos/utils/dither.nim), so thin clients must too: picking
    the nearest colour per pixel turns every gradient and photo into flat
    bands. Pillow diffuses the error in C — a Python loop over 800x480 would
    dominate the render. Palette entries map 1:1 onto the returned indices.
    """
    from PIL import Image

    flat: list[int] = []
    for entry in palette:
        flat.extend(entry)
    reference = Image.new("P", (1, 1))
    reference.putpalette(flat)
    return image.convert("RGB").quantize(
        palette=reference, dither=Image.Dither.FLOYDSTEINBERG).tobytes()


def _dithered_gray_levels(image, levels: int) -> bytes:
    """One gray level (0..levels-1) per pixel, Floyd-Steinberg dithered.

    Luma uses the same weights as the Nim renderer's ``toGrayscaleFloat`` so a
    scene looks the same whether it rendered on-device or here.
    """
    luma = image.convert("RGB").convert("L", (0.21, 0.72, 0.07, 0))
    return _dithered_indices(luma, [(round(i * 255 / (levels - 1)),) * 3 for i in range(levels)])


def _pack_1bpp(image) -> bytes:
    row = (image.width + 7) // 8
    out = bytearray(row * image.height)
    levels = _dithered_gray_levels(image, 2)
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            if levels[base + x]:
                out[y * row + (x >> 3)] |= 0x80 >> (x & 7)
    return bytes(out)


def _pack_dual_1bpp(image, accent: tuple[int, int, int]) -> bytes:
    row = (image.width + 7) // 8
    black = bytearray([0xFF] * (row * image.height))
    color = bytearray([0xFF] * (row * image.height))
    indices = _dithered_indices(image, [(0, 0, 0), accent, (255, 255, 255)])
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            index = indices[base + x]
            if index > 1:
                continue
            plane = black if index == 0 else color
            plane[y * row + (x >> 3)] &= ~(0x80 >> (x & 7))
    return bytes(black + color)


def _pack_2bpp_gray(image) -> bytes:
    row = (image.width + 3) // 4
    out = bytearray(row * image.height)
    levels = _dithered_gray_levels(image, 4)
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            out[y * row + (x >> 2)] |= (levels[base + x] & 0x03) << (6 - ((x & 3) * 2))
    return bytes(out)


def _pack_4bpp_gray(image) -> bytes:
    row = (image.width + 1) // 2
    out = bytearray(row * image.height)
    levels = _dithered_gray_levels(image, 16)
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            out[y * row + (x >> 1)] |= (levels[base + x] & 0x0F) << (4 if (x & 1) == 0 else 0)
    return bytes(out)


def _pack_rgb565(image) -> bytes:
    """One little-endian 5/6/5 word per pixel, the LCD's own format; plain
    rounding (the device's packer jitters the rounding, embedded_main.nim)."""
    rgb = image.convert("RGB")
    out = bytearray(rgb.width * rgb.height * 2)
    i = 0
    for r, g, b in rgb.getdata():
        word = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
        out[i] = word & 0xFF
        out[i + 1] = word >> 8
        i += 2
    return bytes(out)


def _pack_palette(image, palette: list[tuple[int, int, int]], bits: int) -> bytes:
    # Spectra 6 leaves a hole at index 4: dither against the real colours only,
    # then map back to the wire indices the panel expects.
    entries = [(index, rgb) for index, rgb in enumerate(palette) if max(rgb) <= 255]
    wire = bytes(index for index, _ in entries)
    indices = _dithered_indices(image, [rgb for _, rgb in entries])
    divider = 4 if bits == 2 else 2
    row = (image.width + divider - 1) // divider
    out = bytearray(row * image.height)
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            index = wire[indices[base + x]]
            if bits == 2:
                out[y * row + (x >> 2)] |= (index & 0x03) << (6 - ((x & 3) * 2))
            else:
                out[y * row + (x >> 1)] |= (index & 0x0F) << (4 if (x & 1) == 0 else 0)
    return bytes(out)


def render_embedded_diagnostic_bitmap(frame: Frame, width: int, height: int, pixel_format: int) -> bytes:
    """Readable diagnostic card packed in the panel format.

    The fallback for thin-client mode: served when the frame has no scenes
    or the wasm scene render is unavailable/fails, so the device always has
    a deterministic bitmap to fetch end to end.
    """
    return pack_image_for_panel(embedded_diagnostic_image(frame, width, height), pixel_format)


def embedded_diagnostic_image(frame: Frame | _PanelFrame, width: int, height: int):
    """The diagnostic card as a PIL RGB image (also used by virtual frames)."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle([4, 4, width - 5, height - 5], outline=(0, 0, 0), width=3)
    swatches = [
        (0, 0, 0),
        (255, 255, 255),
        (208, 190, 71),
        (156, 72, 75),
        (24, 83, 154),
        (42, 85, 49),
        (177, 106, 73),
        (128, 128, 128),
    ]
    bar_width = max(1, (width - 48) // len(swatches))
    for i, color in enumerate(swatches):
        draw.rectangle([24 + i * bar_width, 24, 24 + (i + 1) * bar_width, 64], fill=color)
    name = frame.name or f"Frame {frame.id}"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    draw.text((32, height * 0.30), "FrameOS", fill=(0, 0, 0))
    draw.text((32, height * 0.40), name, fill=(0, 0, 0))
    draw.text((32, height * 0.50), f"Backend diagnostic bitmap - {stamp}", fill=(0, 0, 0))
    draw.text((32, height * 0.60), "Scenes render on-device in local mode", fill=(0, 0, 0))

    return image


# The stock tables of the palette panels, by `fos_pixel_format_t`: the Nim
# runtime's saturated4ColorPalette / saturated7ColorPalette /
# spectra6ColorPalette (frameos/src/frameos/utils/dither.nim), which
# test_server_rendering pins these against.
STOCK_PANEL_PALETTES: dict[int, list[tuple[int, int, int]]] = {
    FOS_PIXEL_2BPP_BWYR: BWYR_PALETTE,
    FOS_PIXEL_4BPP_7COLOR: SEVEN_COLOR_PALETTE,
    FOS_PIXEL_4BPP_SPECTRA6: SPECTRA6_PALETTE,
}
_HEX_COLOR = re.compile(r"^#?([0-9a-fA-F]{6})$")


def palette_colors(value: object) -> list[tuple[int, int, int]]:
    """A colour list as RGB triples: frame.json's `palette` ({"colors":
    ["#rrggbb", …]}) or the list alone. One unreadable colour empties it, as
    the runtimes' parsers do (fos_nim_set_palette_impl)."""
    if isinstance(value, dict):
        value = value.get("colors")
    if not isinstance(value, list):
        return []
    colors: list[tuple[int, int, int]] = []
    for entry in value:
        match = _HEX_COLOR.match(entry.strip()) if isinstance(entry, str) else None
        if match is None:
            return []
        digits = match.group(1)
        colors.append((int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)))
    return colors


def fit_palette_override(
    override: list[tuple[int, int, int]], default: list[tuple[int, int, int]]
) -> list[tuple[int, int, int]]:
    """``fitPaletteOverride`` (frameos/utils/dither.nim): ``override`` when it
    names as many colours as ``default``, or one fewer on Spectra 6, whose
    hole at index 4 is put back; anything else is ``default``."""
    if not override:
        return default
    if len(override) == len(default):
        return list(override)
    if len(default) == len(override) + 1 and len(default) > 4 and default[4][0] >= 999:
        return [*override[:4], default[4], *override[4:]]
    return default


def panel_palette(
    pixel_format: int, frame_palette: object = None, photo_palette: object = None
) -> list[tuple[int, int, int]] | None:
    """The colours a palette panel is dithered to, as the device's packer
    picks them (``activePalette(framePalette(stock))`` in embedded_main.nim,
    docs/server-rendering.md "Packing"): a photo's own dither palette from
    the render, else the frame's `palette`, each fitted onto the stock
    table. None for a format without a palette."""
    stock = STOCK_PANEL_PALETTES.get(int(pixel_format))
    if stock is None:
        return None
    return fit_palette_override(palette_colors(photo_palette), fit_palette_override(palette_colors(frame_palette), stock))


def pack_image_for_panel(image, pixel_format: int, palette: list[tuple[int, int, int]] | None = None) -> bytes:
    """Pack an RGB(A) PIL image into the panel's FOSB payload format.
    ``palette`` replaces a palette panel's stock colours (panel_palette):
    what each pixel is dithered to, never which index it is written as."""
    if pixel_format in STOCK_PANEL_PALETTES:
        stock = STOCK_PANEL_PALETTES[pixel_format]
        colors = palette if palette is not None and len(palette) == len(stock) else stock
        return _pack_palette(image, colors, 2 if pixel_format == FOS_PIXEL_2BPP_BWYR else 4)
    if pixel_format == FOS_PIXEL_1BPP:
        return _pack_1bpp(image)
    if pixel_format == FOS_PIXEL_DUAL_1BPP_RED:
        return _pack_dual_1bpp(image, (255, 0, 0))
    if pixel_format == FOS_PIXEL_DUAL_1BPP_YELLOW:
        return _pack_dual_1bpp(image, (255, 255, 0))
    if pixel_format == FOS_PIXEL_2BPP_GRAY:
        return _pack_2bpp_gray(image)
    if pixel_format == FOS_PIXEL_4BPP_GRAY:
        return _pack_4bpp_gray(image)
    if pixel_format == FOS_PIXEL_RGB565:
        return _pack_rgb565(image)
    raise ValueError(f"Unsupported embedded pixel format: {pixel_format}")


def embedded_scene_dimensions(frame: Frame, width: int, height: int) -> tuple[int, int]:
    """The size the scene renders at for a panel of ``width`` x ``height``.

    A frame hung in portrait (``rotate`` 90 or 270) runs its scenes on the
    swapped canvas, exactly as the on-device runtime does (runner.nim); the
    result is turned back to the panel's native orientation before packing.
    """
    if int(frame.rotate or 0) % 360 in (90, 270):
        return height, width
    return width, height


def rotate_for_panel(image, rotate: int):
    """Turn a rendered scene to the panel's native orientation.

    Same direction as ``rotateDegrees`` in frameos/utils/image.nim, which a
    frame with its own renderer applies last: clockwise by ``rotate``. A thin
    client has no pixels of its own to turn, so the control plane does it.
    """
    from PIL import Image

    rotate = int(rotate or 0) % 360
    if rotate == 90:
        return image.transpose(Image.Transpose.ROTATE_270)  # PIL counts counter-clockwise
    if rotate == 180:
        return image.transpose(Image.Transpose.ROTATE_180)
    if rotate == 270:
        return image.transpose(Image.Transpose.ROTATE_90)
    return image


def fosb_payload(width: int, height: int, pixel_format: int, packed: bytes) -> bytes:
    header = b"FOSB" + struct.pack("<BBHHH", 1, pixel_format, width, height, 0)
    return header + packed


def _thin_client_preview_key(frame_id: int) -> str:
    return f"frame:{frame_id}:thin_client_preview"


async def set_thin_client_preview(
    redis, frame: Frame, scenes: list, scene_id: str | None, state: dict | None = None
) -> None:
    """A "Preview on frame" for a thin client without the command queue (the
    Pico): its render pull runs these scenes, showing `scene_id` with
    `state`, in place of the saved ones until the next deploy or scene switch
    clears it. That is the rule a queued preview follows
    (frame_commands.previewed_scenes), kept here because nothing is queued for
    a board that pulls no queue. The state rides in the record: the scene
    store keeps saved scenes' fields only."""
    record = {
        "scenes": [scene for scene in scenes if isinstance(scene, dict)],
        "sceneId": scene_id,
        "state": state or {},
    }
    await redis.set(_thin_client_preview_key(int(frame.id)), json.dumps(record, separators=(",", ":")))


async def clear_thin_client_preview(redis, frame: Frame) -> None:
    await redis.delete(_thin_client_preview_key(int(frame.id)))


async def _thin_client_preview(redis, frame: Frame) -> dict | None:
    if redis is None:
        return None
    try:
        raw = await redis.get(_thin_client_preview_key(int(frame.id)))
        record = json.loads(raw) if raw else None
    except Exception:
        return None
    if not isinstance(record, dict) or not isinstance(record.get("scenes"), list):
        return None
    return record


async def _thin_client_scenes(
    db: Session, redis, frame: Frame, scene_states: dict, device_scene: str | None = None
) -> tuple[list | None, str | None, dict]:
    """The scenes a thin client's render runs (None: the saved ones), the
    scene it shows (None: the default) and the states it is seeded with. A
    preview, pushed (the Pico) or queued (an ESP32-C3), runs in place of the
    saved scenes. ``device_scene`` is the scene the board's own runtime is
    on, from its pull (an ESP32-S3 rendered on the server)."""
    preview = await _thin_client_preview(redis, frame)
    if preview is not None:
        scenes = preview["scenes"]
        scene_id = preview.get("sceneId")
        if not isinstance(scene_id, str) or not scene_id:
            scene_id = await _active_scene_id(redis, frame, scenes)
        state = preview.get("state")
        if scene_id and isinstance(state, dict) and state:
            scene_states = {**scene_states, scene_id: {**scene_states.get(scene_id, {}), **state}}
        return scenes, scene_id, scene_states
    queued = previewed_scenes(db, frame)
    return queued, await _scene_to_draw(db, redis, frame, queued, device_scene), scene_states


async def _scene_to_draw(
    db: Session, redis, frame: Frame, scenes: list | None, device_scene: str | None
) -> str | None:
    """docs/server-rendering.md "Which scene": a switch the backend queued
    that the board has not taken yet is the backend's to make; otherwise the
    board's own runtime says which scene it is on (a key, the schedule, a
    switch it already took), when that is one of the frame's scenes; then
    the backend's active scene, then the default. The board's word becomes
    the backend's active scene, so a picture drawn ahead of its next wake
    shows the same scene."""
    if device_scene:
        source = scenes if scenes is not None else (frame.scenes or [])
        known = {scene.get("id") for scene in source if isinstance(scene, dict)}
        if device_scene in known and "set_current_scene" not in pending_command_types(db, frame):
            if redis is not None:
                key = f"frame:{frame.id}:active_scene"
                try:
                    current = await redis.get(key)
                    if isinstance(current, bytes):
                        current = current.decode("utf-8", errors="replace")
                    if current != device_scene:
                        await redis.set(key, device_scene)
                except Exception:
                    pass
            return device_scene
    return await _active_scene_id(redis, frame, scenes, built_in=True)


async def _active_scene_id(
    redis, frame: Frame, scenes: list | None = None, *, built_in: bool = False
) -> str | None:
    """The workspace-activated scene, when one is cached and is one of
    `scenes` (default: the saved ones); None lets the wasm runtime fall back
    to the scene marked default (same choice the device runtime makes).
    ``built_in``: the scene switcher or the scene settings count too, which
    the render pull of a frame rendered here keeps while the frame is awake
    (docs/server-rendering.md "Keys, touch and the schedule")."""
    if redis is None:
        return None
    try:
        value = await redis.get(f"frame:{frame.id}:active_scene")
    except Exception:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not value:
        return None
    # The cache outlives the scene: after the scene is deleted or replaced
    # (a scenes.json overwrite, a workspace that activated something that
    # is gone) the wasm harness fails "scene not found" on every poll and the
    # thin client shows the diagnostic card until someone activates another
    # scene (bench-c3, 2026-09-05). A stale id is the same as no id.
    source = scenes if scenes is not None else (frame.scenes or [])
    known = {scene.get("id") for scene in source if isinstance(scene, dict)}
    if built_in and value in BUILT_IN_SCENE_IDS:
        return value
    return value if value in known else None


async def _keep_rendered_scene(redis, frame: Frame, plan: "_ThinClientPlan", rendered_state: dict | None) -> None:
    """The scene the render ended on is the frame's now: a relayed key, a
    tap or a schedule entry may have switched it (its own `setCurrentScene`,
    the event map's previous / next, the scene switcher), and the next pull
    must draw that one (docs/server-rendering.md "Keys, touch and the
    schedule"). A built-in scene is kept too, until the frame sleeps
    (leave_built_in_scene)."""
    if redis is None or not isinstance(rendered_state, dict):
        return
    scene_id = rendered_state.get("sceneId")
    if not isinstance(scene_id, str) or not scene_id:
        return
    source = plan.scenes_override if plan.scenes_override is not None else (frame.scenes or [])
    known = {scene.get("id") for scene in source if isinstance(scene, dict)}
    if scene_id not in known and scene_id not in BUILT_IN_SCENE_IDS:
        return
    key = f"frame:{frame.id}:active_scene"
    try:
        current = await redis.get(key)
        if isinstance(current, bytes):
            current = current.decode("utf-8", errors="replace")
        if current != scene_id:
            await redis.set(key, scene_id)
    except Exception:
        # A scene that could not be remembered must not cost the device its frame.
        pass


async def leave_built_in_scene(redis, frame: Frame) -> None:
    """A frame rendered here that is going to sleep while the scene switcher
    or the scene settings show goes back to the scene they were opened from
    (their `state.from`), as its own runtime would: a device never keeps a
    built-in scene through a sleep. Before the picture for the wake is drawn
    (models/log.py). The built-in scene's kept state goes too."""
    from app.tasks.embedded_firmware import is_thin_client_frame
    from .virtual_frame import get_virtual_scene_states, replace_virtual_scene_states

    if redis is None or not is_thin_client_frame(frame):
        return
    key = f"frame:{frame.id}:active_scene"
    try:
        current = await redis.get(key)
    except Exception:
        return
    if isinstance(current, bytes):
        current = current.decode("utf-8", errors="replace")
    if current not in BUILT_IN_SCENE_IDS:
        return
    try:
        states = await get_virtual_scene_states(redis, frame)
    except Exception:
        states = {}
    kept = states.pop(current, None)
    opener = kept.get("from") if isinstance(kept, dict) else None
    known = {scene.get("id") for scene in (frame.scenes or []) if isinstance(scene, dict)}
    try:
        if isinstance(opener, str) and opener in known:
            await redis.set(key, opener)
        else:
            await redis.delete(key)
        if kept is not None:
            await replace_virtual_scene_states(redis, frame, states)
    except Exception:
        pass


# What a thin client's scene would have heard since its last pull: a few
# edges or events per press, and a board that was mashed is still a handful
# (frameos/relayed_input.nim takes 32, edges and events together).
MAX_DEVICE_INPUT_BYTES = 16 * 1024
MAX_DEVICE_INPUT_EDGES = 32
MAX_DEVICE_EVENT_NAME = 64
_DEVICE_INPUT_LABEL = re.compile(r"^[A-Za-z0-9_.-]{1,16}$")
# The producers a board has besides its control plane (relayed_input.nim
# RelayedOrigins): what the plane sent it is the plane's already, and the
# console (`system`) stays on the board.
RELAYED_EVENT_ORIGINS = frozenset({"driver", "schedule", "http:write", "http:admin"})


def _json_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def embedded_device_input(body: object) -> dict:
    """What a thin client sent with its render pull, as the wasm runtime takes
    it (frameos/relayed_input.nim; docs/server-rendering.md "Keys, touch and
    the schedule"): ``{"nowMs": <the board's clock>, "edges": [{"label",
    "action": "down" | "up", "atMs", "pin"?, "wake"?, "claimed"?}],
    "events": [{"origin", "name", "payload"}]}``, oldest first, at least one
    of the lists. The Pico sends its button edges; an ESP32 rendered on the
    server what its producers would have handed its own scene, each with its
    origin. A body of another shape is a 400; an edge or event that says
    nothing usable (an origin the board does not have, a payload that is
    not an object) is dropped, and past MAX_DEVICE_INPUT_EDGES, both lists
    together, the rest are. ``events`` is in the result only when it holds
    one."""
    if not isinstance(body, dict) or not _json_int(body.get("nowMs")):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Expected {nowMs, edges} or {nowMs, events}")
    raw_edges, raw_events = body.get("edges"), body.get("events")
    if (raw_edges is None and raw_events is None) or (
        raw_edges is not None and not isinstance(raw_edges, list)
    ) or (raw_events is not None and not isinstance(raw_events, list)):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Expected {nowMs, edges} or {nowMs, events}")
    now_ms = int(body["nowMs"])
    edges: list[dict] = []
    for edge in raw_edges or []:
        if len(edges) >= MAX_DEVICE_INPUT_EDGES:
            break
        if not isinstance(edge, dict):
            continue
        label, action, at_ms = edge.get("label"), edge.get("action"), edge.get("atMs")
        if not isinstance(label, str) or not _DEVICE_INPUT_LABEL.match(label):
            continue
        if action not in ("down", "up") or isinstance(at_ms, bool) or not isinstance(at_ms, int):
            continue
        if not 0 <= at_ms <= now_ms:
            continue
        kept: dict = {"label": label, "action": action, "atMs": at_ms}
        if _json_int(edge.get("pin")):
            kept["pin"] = edge["pin"]
        if edge.get("wake") is True:
            kept["wake"] = True
        if edge.get("claimed") is True:
            kept["claimed"] = True
        edges.append(kept)
    events: list[dict] = []
    for event in raw_events or []:
        if len(edges) + len(events) >= MAX_DEVICE_INPUT_EDGES:
            break
        if not isinstance(event, dict):
            continue
        origin, name, payload = event.get("origin"), event.get("name"), event.get("payload", {})
        if origin not in RELAYED_EVENT_ORIGINS:
            continue
        if not isinstance(name, str) or not 0 < len(name) <= MAX_DEVICE_EVENT_NAME:
            continue
        if not isinstance(payload, dict):
            continue
        events.append({"origin": origin, "name": name, "payload": payload})
    result: dict = {"nowMs": now_ms, "edges": edges}
    if events:
        result["events"] = events
    return result


def device_input_says_anything(device_input: dict | None) -> bool:
    """Whether a relayed input carries an edge or an event to deliver."""
    return bool(device_input and (device_input.get("edges") or device_input.get("events")))


# Scene events sent to a thin client wait for its next render pull; a board
# asleep for a day still gets the last few.
MAX_THIN_CLIENT_EVENTS = 32


def _thin_client_events_key(frame_id: int) -> str:
    return f"frame:{frame_id}:thin_client_events"


async def hold_thin_client_event(redis, frame: Frame, name: str, payload: object, origin: str = "http:admin") -> None:
    """A scene event for a thin client (a custom event from the workspace, a
    `button` said over HTTP). The board has no runtime to hand it to, so it
    waits here, and the board's next render pull runs it in the scene before
    drawing: the board is only asked to pull. The oldest go first past
    MAX_THIN_CLIENT_EVENTS."""
    key = _thin_client_events_key(int(frame.id))
    record = {"name": name, "payload": payload if isinstance(payload, dict) else {}, "origin": origin}
    await redis.rpush(key, json.dumps(record, separators=(",", ":")))
    await redis.ltrim(key, -MAX_THIN_CLIENT_EVENTS, -1)
    # A picture drawn ahead of the board's wake did not hear it.
    await bump_render_revision(redis, int(frame.id))


async def _held_thin_client_event_count(redis, frame: Frame) -> int:
    if redis is None:
        return 0
    try:
        return int(await redis.llen(_thin_client_events_key(int(frame.id))))
    except Exception:
        return 0


async def _take_thin_client_events(redis, frame: Frame) -> list[dict]:
    """Every held event, oldest first, gone from the store: one pull runs
    them, and a pull that runs at the same time does not get them twice."""
    if redis is None:
        return []
    key = _thin_client_events_key(int(frame.id))
    try:
        async with redis.pipeline(transaction=True) as pipe:
            pipe.lrange(key, 0, -1)
            pipe.delete(key)
            raw, _deleted = await pipe.execute()
    except Exception:
        return []
    events: list[dict] = []
    for item in raw or []:
        try:
            record = json.loads(item)
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict) and isinstance(record.get("name"), str) and record["name"]:
            events.append(record)
    return events


async def _give_back_thin_client_events(redis, frame: Frame, events: list[dict]) -> None:
    """A pull turned away before it rendered (the queue was full): the events
    go back in front of anything held since, for the retry."""
    if not events:
        return
    key = _thin_client_events_key(int(frame.id))
    try:
        for record in reversed(events):
            await redis.lpush(key, json.dumps(record, separators=(",", ":")))
        await redis.ltrim(key, -MAX_THIN_CLIENT_EVENTS, -1)
    except Exception:
        pass


async def _log_scene_heard(db: Session, redis, frame: Frame, scene_logs: list[str]) -> None:
    """What the scene heard of a thin client's presses and of the events held
    for it, into the frame log: the dispatcher's `event:*` lines (the `gpio`
    edges, the `button` they made, a custom event, what the scene dispatched
    in turn), as an ESP32's own runtime logs them. Only for a pull that
    carried any; an ordinary poll logs nothing."""
    from app.models.log import new_log

    for line in scene_logs:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        event = entry.get("event")
        # `open` is the fresh render process starting its scene, not news.
        if not isinstance(event, str) or not event.startswith("event:") or entry.get("origin") == "system":
            continue
        await new_log(db, redis, int(frame.id), "webhook", line)


# The board's word for which scene it is on (docs/server-rendering.md "Which
# scene"): a scene id as the runtime keeps it.
MAX_DEVICE_SCENE_CHARS = 256


def _device_scene(scene: str | None) -> str | None:
    if not isinstance(scene, str):
        return None
    scene = scene.strip()
    return scene if 0 < len(scene) <= MAX_DEVICE_SCENE_CHARS else None


@api_public.get("/frames/{id:int}/embedded/render")
async def api_embedded_device_render(
    id: int,
    scene: str | None = Query(None),
    db: Session = Depends(get_db),
    redis=Depends(get_redis),
    authorization: str = Header(None),
    if_none_match: str | None = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    return await _embedded_render_response(
        db, redis, frame, device_scene=_device_scene(scene), if_none_match=if_none_match
    )


@api_public.post("/frames/{id:int}/embedded/render")
async def api_embedded_device_render_with_input(
    id: int,
    request: Request,
    scene: str | None = Query(None),
    db: Session = Depends(get_db),
    redis=Depends(get_redis),
    authorization: str = Header(None),
    if_none_match: str | None = Header(None),
):
    """The pull of a thin client whose buttons were pressed since the last
    one: the same frame, with the presses delivered to the scene first, as
    its driver's `gpio` edges (docs/events.md, "Thin clients")."""
    frame = _embedded_frame_from_bearer(db, id, authorization)
    raw = await request.body()
    if len(raw) > MAX_DEVICE_INPUT_BYTES:
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="Body too large")
    try:
        body = json.loads(raw or b"null")
    except ValueError:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid JSON")
    return await _embedded_render_response(
        db,
        redis,
        frame,
        embedded_device_input(body),
        device_scene=_device_scene(scene),
        if_none_match=if_none_match,
    )


@dataclass
class _ThinClientPlan:
    """What one picture of a thin client is drawn from: the panel, the
    scenes (None: the saved ones), the scene shown (None: the default), the
    stored states it is seeded with and the service settings. The
    fingerprint names all of it but the states (docs/server-rendering.md)."""

    width: int
    height: int
    scene_width: int
    scene_height: int
    pixel_format: int
    scenes_override: list | None
    scene_id: str | None
    scene_states: dict
    settings: dict
    frame_json: dict
    fingerprint: str


def thin_client_frame_json(frame: Frame, pixel_format: int) -> dict:
    """What else of frame.json the frame's own runtime keeps, for its render
    here (frameos_wasm_set_frame): its event map (only when the backend holds
    one, as `/embedded/settings` sends it), its palette and colours, its
    buttons, its panel's format and its rotation."""
    colors = getattr(frame, "colors", None)
    frame_json: dict = {
        "palette": [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in palette_colors(getattr(frame, "palette", None))],
        "colors": colors if isinstance(colors, dict) else {},
        "pixelFormat": int(pixel_format),
        "rotate": int(getattr(frame, "rotate", 0) or 0) % 360,
    }
    event_map = getattr(frame, "event_map", None)
    if isinstance(event_map, list):
        frame_json["eventMap"] = normalize_event_map(event_map)
    buttons = getattr(frame, "gpio_buttons", None)
    if isinstance(buttons, list):
        frame_json["gpioButtons"] = [dict(button) for button in buttons if isinstance(button, dict)]
    return frame_json


async def _thin_client_plan(db: Session, redis, frame: Frame, device_scene: str | None = None) -> _ThinClientPlan:
    # A thin client keeps no scene state — every pass is a fresh wasm process
    # — so the backend is the memory, exactly as for virtual frames and in
    # the same redis store: seed the renderer with it, keep what comes back.
    # Without this a slideshow never advances. (Imported here: virtual_frame
    # imports this module.)
    from .virtual_frame import get_virtual_scene_states

    width, height = embedded_render_dimensions(frame)
    scene_width, scene_height = embedded_scene_dimensions(frame, width, height)
    pixel_format = embedded_pixel_format_for_panel(embedded_panel_for_frame(frame))
    try:
        scene_states = await get_virtual_scene_states(redis, frame)
    except Exception:
        # Same tolerance as _active_scene_id: no redis, no memory, still a frame.
        scene_states = {}
    scenes_override, scene_id, scene_states = await _thin_client_scenes(
        db, redis, frame, scene_states, device_scene
    )
    settings = embedded_settings_payload(db, frame)
    frame_json = thin_client_frame_json(frame, pixel_format)
    fingerprint = render_fingerprint(
        scenes_override if scenes_override is not None else (frame.scenes or []),
        # The packer's palette and the render's event map and colours are
        # what the picture was drawn from too.
        {"settings": settings, "frame": frame_json},
        scene_id,
        width,
        height,
        pixel_format,
        int(frame.rotate or 0),
    )
    return _ThinClientPlan(
        width=width,
        height=height,
        scene_width=scene_width,
        scene_height=scene_height,
        pixel_format=pixel_format,
        scenes_override=scenes_override,
        scene_id=scene_id,
        scene_states=scene_states,
        settings=settings,
        frame_json=frame_json,
        fingerprint=fingerprint,
    )


async def _keep_rendered_state(redis, frame: Frame, rendered_state: dict | None) -> None:
    """Store the state a render ended with, under the scene the renderer says
    it showed. A render whose state seeding failed (old wasm bundle without
    the set_scene_state export) reads back bare scene defaults, which must
    not clobber the store."""
    from .virtual_frame import store_rendered_scene_state

    if not isinstance(rendered_state, dict):
        return
    state = rendered_state.get("state")
    if isinstance(state, dict) and rendered_state.get("seeded", True):
        try:
            await store_rendered_scene_state(redis, frame, rendered_state.get("sceneId"), state)
        except Exception:
            # A state that could not be saved must not cost the device its frame.
            pass


@dataclass(frozen=True)
class _PanelFrame:
    """What packing reads of a frame (the diagnostic card's name and id, the
    rotation, the palette), read on the event loop: the packing runs on a
    worker thread, where an ORM row expired by a commit would lazy-load on
    the request's session from the wrong thread."""

    id: int
    name: str | None
    rotate: int
    palette: object

    @classmethod
    def of(cls, frame: Frame) -> "_PanelFrame":
        return cls(int(frame.id), frame.name, int(frame.rotate or 0), getattr(frame, "palette", None))


async def _fosb_off_the_loop(
    frame: Frame, plan: _ThinClientPlan, rgba: bytes | None, photo_palette: list[str] | None = None
) -> bytes:
    """_fosb_from_rgba on a worker thread. Dithering a 13.3" Spectra 6 panel
    is ~0.2 s of CPU, which on the event loop stalls every other request and
    every device's pull meanwhile (Pillow lets go of the GIL in its convert,
    and the Python part is preempted). The cloud packs in its render worker
    for the same reason (docs/server-rendering.md "Packing")."""
    return await asyncio.to_thread(_fosb_from_rgba, _PanelFrame.of(frame), plan, rgba, photo_palette)


def _fosb_from_rgba(
    frame: Frame | _PanelFrame,
    plan: _ThinClientPlan,
    rgba: bytes | None,
    photo_palette: list[str] | None = None,
) -> bytes:
    """The panel's bitmap: the render turned and packed, or, without one, the
    diagnostic card, drawn upright for the viewer and turned like a scene.
    Dithered to the colours the device's own packer would use
    (panel_palette): ``photo_palette`` is the render's photo palette."""
    from PIL import Image

    if rgba is not None:
        image = Image.frombytes("RGBA", (plan.scene_width, plan.scene_height), rgba).convert("RGB")
    else:
        image = embedded_diagnostic_image(frame, plan.scene_width, plan.scene_height)
    palette = panel_palette(
        plan.pixel_format, getattr(frame, "palette", None), photo_palette if rgba is not None else None
    )
    packed = pack_image_for_panel(rotate_for_panel(image, frame.rotate), plan.pixel_format, palette)
    expected = embedded_buffer_size(plan.width, plan.height, plan.pixel_format)
    if len(packed) != expected:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                            detail=f"packed buffer {len(packed)} != expected {expected}")
    return fosb_payload(plan.width, plan.height, plan.pixel_format, packed)


async def _render_thin_client_now(
    db: Session,
    redis,
    frame: Frame,
    plan: _ThinClientPlan,
    *,
    control_events: list[dict],
    relayed: dict | None,
) -> bytes:
    """One render for the pull, the held events and the board's presses
    heard first.

    The frame's scenes run inside the wasm scene runtime (QuickJS sandboxed in
    wasm) in a bounded Node subprocess. Any failure — no scenes, no node/wasm
    toolchain, scene error, timeout — falls back to the diagnostic bitmap, so
    the device always gets a valid frame."""
    scene_logs: list[str] = []
    photo_palette: list[str] = []
    started = time.monotonic()
    try:
        rgba, rendered_state, _saved_assets = await render_scene_rgba_and_state(
            frame,
            plan.scene_width,
            plan.scene_height,
            scene_id=plan.scene_id,
            settings=plan.settings,
            scenes_override=plan.scenes_override,
            scene_states=plan.scene_states,
            control_events=control_events or None,
            device_input=relayed,
            scene_logs=scene_logs,
            frame_json=plan.frame_json,
            render_palette=photo_palette,
        )
    except RenderQueueFull as exc:
        await _give_back_thin_client_events(redis, frame, control_events)
        # Not a render failure but a full queue: the device keeps what it
        # shows and polls again after Retry-After, instead of this request
        # parking until a slot frees (or a diagnostic card replacing a
        # perfectly good scene).
        raise HTTPException(
            status_code=HTTPStatus.SERVICE_UNAVAILABLE,
            detail="Render queue is full, retry later",
            headers={"Retry-After": str(exc.retry_after)},
        )
    if rgba is not None:
        # What the next pre-render's lead is worked out from.
        await remember_render_ms(redis, int(frame.id), int((time.monotonic() - started) * 1000))
    await _keep_rendered_state(redis, frame, rendered_state)
    if rgba is not None and rendered_state is not None and rendered_state.get("seeded", True):
        await _keep_rendered_scene(redis, frame, plan, rendered_state)
    if relayed or control_events:
        try:
            await _log_scene_heard(db, redis, frame, scene_logs)
        except Exception:
            # Nor may a log line that could not be written.
            pass
    return await _fosb_off_the_loop(frame, plan, rgba, photo_palette)


async def _embedded_render_response(
    db: Session,
    redis,
    frame: Frame,
    device_input: dict | None = None,
    *,
    device_scene: str | None = None,
    if_none_match: str | None = None,
) -> Response:
    """The render pull (docs/server-rendering.md "The render pull"): the
    picture drawn ahead of the board's wake when it is still the one to show,
    else a render now; 304 when the board already shows it."""
    plan = await _thin_client_plan(db, redis, frame, device_scene)
    relayed = device_input if device_input_says_anything(device_input) else None
    # Taken whether it is used or not: a kept picture is used once, and one
    # that does not fit this pull will not fit a later one either.
    kept = await take_prerender(redis, int(frame.id))
    control_events = await _take_thin_client_events(redis, frame)
    body: bytes | None = None
    if kept is not None and relayed is None and not control_events:
        record, kept_body = kept
        if prerender_usable(
            record,
            fingerprint=plan.fingerprint,
            revision=await render_revision(redis, int(frame.id)),
            now_ms=int(time.time() * 1000),
        ):
            body = kept_body
            # Its state is the scene's now: committed when shown, not drawn.
            await _keep_rendered_state(redis, frame, record.get("state"))
    if body is None:
        body = await _render_thin_client_now(
            db, redis, frame, plan, control_events=control_events, relayed=relayed
        )
    etag = fosb_etag(body)
    headers = {"ETag": etag, "Cache-Control": "no-store"}
    if etag_matches(if_none_match, etag):
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers=headers)
    return Response(content=body, media_type="application/octet-stream", headers=headers)


async def prerender_thin_client(db: Session, redis, frame: Frame, as_of_ms: int) -> bool:
    """Draw a sleeping thin client's next picture ahead of its wake, as of
    ``as_of_ms`` (docs/server-rendering.md "Deep sleep"), and keep it for the
    pull at the wake. False when nothing was kept: not a thin client, awake
    already, an event waiting (the pull must hear it), the wake past, a
    render that failed, or the scene changed while it drew."""
    from app.tasks.embedded_firmware import is_thin_client_frame

    if not is_thin_client_frame(frame):
        return False
    if time.time() * 1000 - as_of_ms > PRERENDER_MAX_SKEW_SECONDS * 1000:
        return False
    as_of = prerender_as_of(frame)
    if as_of is None or abs(epoch_ms(as_of) - as_of_ms) > 1000:
        return False
    if await _held_thin_client_event_count(redis, frame) > 0:
        return False
    revision = await render_revision(redis, int(frame.id))
    plan = await _thin_client_plan(db, redis, frame)
    photo_palette: list[str] = []
    started = time.monotonic()
    try:
        rgba, rendered_state, _saved_assets = await render_scene_rgba_and_state(
            frame,
            plan.scene_width,
            plan.scene_height,
            scene_id=plan.scene_id,
            settings=plan.settings,
            scenes_override=plan.scenes_override,
            scene_states=plan.scene_states,
            now_ms=as_of_ms,
            frame_json=plan.frame_json,
            render_palette=photo_palette,
        )
    except RenderQueueFull:
        return False
    if rgba is None:
        # The pull at the wake renders (and falls back to the card) itself.
        return False
    await remember_render_ms(redis, int(frame.id), int((time.monotonic() - started) * 1000))
    body = await _fosb_off_the_loop(frame, plan, rgba, photo_palette)
    # Still asleep for the same wake, and nothing written or held meanwhile?
    # The frame row is read again outside the transaction the plan read in.
    db.rollback()
    fresh = db.get(Frame, int(frame.id), populate_existing=True)
    as_of = prerender_as_of(fresh) if fresh is not None else None
    if as_of is None or abs(epoch_ms(as_of) - as_of_ms) > 1000:
        return False
    if await render_revision(redis, int(frame.id)) != revision:
        return False
    if await _held_thin_client_event_count(redis, frame) > 0:
        return False
    await keep_prerender(
        redis,
        int(frame.id),
        {
            "asOfMs": int(as_of_ms),
            "sceneId": plan.scene_id,
            "revision": revision,
            "fingerprint": plan.fingerprint,
            "state": rendered_state,
            "etag": fosb_etag(body),
        },
        body,
        int(as_of_ms),
    )
    return True


def embedded_scenes_payload(db: Session, frame: Frame) -> bytes:
    """The frame's scenes as the JSON array the on-device interpreter loads.

    Embedded frames run every scene interpreted (there is no on-device
    compiler), so unlike Linux fast-deploy this does not filter on
    ``settings.execution``.

    A "Preview on frame" queued since the last deploy is served in place of
    the saved scenes until the next deploy (frame_commands.previewed_scenes).

    Firmware older than a retired Nim app's replacement gets its keyword back
    (utils/retired_apps.py). The payload — and so the ETag — follows the
    version the board reported at boot, which is what moves it onto the
    JavaScript app on its first pull after the OTA that removed the Nim one.
    """
    source = previewed_scenes(db, frame)
    if source is None:
        source = frame.scenes or []
    scenes = [scene for scene in source if isinstance(scene, dict)]
    scenes = scenes_for_embedded_runtime(scenes, frame_runtime_version(frame))
    return json.dumps(scenes, separators=(",", ":"), sort_keys=True).encode("utf-8")


# One-scene-at-a-time on the pull: what the frame was last served, per scene,
# so its next pull can be answered with only what changed. Redis, not a
# column: losing it costs one whole-set pull (a patch is only ever a saving).
SERVED_SCENES_KEY = "frame:{}:embedded_served_scenes"
SERVED_SCENES_TTL_SECONDS = 30 * 24 * 3600


def _scene_hash(scene: dict) -> str:
    return hashlib.sha256(json.dumps(scene, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest()


async def _embedded_scenes_patch(redis, frame: Frame, payload: bytes, if_none_match: str) -> bytes | None:
    """The body of `/embedded/scenes?patch=1` when the frame holds a set this
    backend served: only the scenes that changed since it, and the id of every
    scene it should hold in order (the rest are dropped). None = send it all
    (firmware side: ``apply_backend_patch`` in fos_scenes.c)."""
    if redis is None:
        return None
    try:
        raw = await redis.get(SERVED_SCENES_KEY.format(int(frame.id)))
        served = json.loads(raw) if raw else None
    except Exception:
        return None
    if not isinstance(served, dict) or served.get("etag") != if_none_match:
        return None
    hashes = served.get("hashes")
    if not isinstance(hashes, dict):
        return None
    scenes = json.loads(payload)
    ids = [scene.get("id") for scene in scenes if isinstance(scene, dict)]
    if len(ids) != len(scenes) or not all(isinstance(scene_id, str) and scene_id for scene_id in ids):
        return None
    if len(set(ids)) != len(ids):
        return None
    put = [scene for scene in scenes if hashes.get(scene["id"]) != _scene_hash(scene)]
    if len(put) == len(scenes):
        # Every scene changed: the whole list is the same message.
        return None
    return json.dumps(
        {"patch": True, "base": if_none_match, "order": ids, "put": put},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


async def _remember_served_scenes(redis, frame: Frame, payload: bytes, etag: str) -> None:
    if redis is None:
        return
    try:
        scenes = json.loads(payload)
        hashes = {
            scene["id"]: _scene_hash(scene)
            for scene in scenes
            if isinstance(scene, dict) and isinstance(scene.get("id"), str)
        }
        await redis.set(
            SERVED_SCENES_KEY.format(int(frame.id)),
            json.dumps({"etag": etag, "hashes": hashes}, separators=(",", ":")),
            ex=SERVED_SCENES_TTL_SECONDS,
        )
    except Exception:
        return


def embedded_settings_payload(db: Session, frame: Frame) -> dict:
    """The service-settings groups this frame is granted, as frame.json
    carries them: what the owner's scenes declare plus what store-origin
    scenes declare AND the owner granted (shipped_frame_settings, via
    get_frame_json). A hard-coded list of four groups used to sit here, so a
    newly granted group never reached an ESP32; the granted set is the one
    source now. Groups without a configured value are left out."""
    frame_settings = get_frame_json(db, frame).get("settings") or {}
    # A preview in place of the saved scenes (the editor's, the voice chat's
    # show_image): what ITS apps declare rides along too, else the device
    # draws "please provide an API key" for a scene the owner just asked for.
    # Owner-authored, so declared is granted, as for the saved scenes.
    preview = previewed_scenes(db, frame)
    if preview and isinstance(frame_settings, dict):
        from types import SimpleNamespace
        from typing import cast

        # Only the two attributes shipped_frame_settings reads; typed as a
        # Frame for its signature.
        stand_in = cast(Frame, SimpleNamespace(scenes=[s for s in preview if isinstance(s, dict)],
                                               service_setting_groups=frame.service_setting_groups))
        for key, value in shipped_frame_settings(stand_in, get_settings_dict(db, project_id=frame.project_id)).items():
            frame_settings.setdefault(key, value)
    payload: dict = {}
    if not isinstance(frame_settings, dict):
        return payload
    for key, value in frame_settings.items():
        if isinstance(key, str) and key and isinstance(value, dict):
            payload[key] = value
    return payload


@api_public.get("/frames/{id:int}/embedded/scenes")
async def api_embedded_device_scenes(
    id: int,
    patch: bool = Query(False),
    db: Session = Depends(get_db),
    redis=Depends(get_redis),
    authorization: str = Header(None),
    if_none_match: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    payload = embedded_scenes_payload(db, frame)
    etag = embedded_payload_etag(payload)
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers={"ETag": etag})
    body = payload
    if patch and if_none_match:
        body = await _embedded_scenes_patch(redis, frame, payload, if_none_match.strip()) or payload
    await _remember_served_scenes(redis, frame, payload, etag)
    return Response(content=body, media_type="application/json",
                    headers={"ETag": etag})


def embedded_payload_etag(payload: bytes) -> str:
    """The ETag of a device pull: the payload's sha256, quoted. The device
    sends it back as If-None-Match on the next pull, and reports it on its
    commands pull as the checksum of what it holds — which is how a queued
    deploy learns it has been applied (app/api/embedded_commands.py)."""
    return f'"{hashlib.sha256(payload).hexdigest()}"'


def embedded_scenes_etag(db: Session, frame: Frame) -> str:
    return embedded_payload_etag(embedded_scenes_payload(db, frame))


def embedded_settings_document(db: Session, frame: Frame) -> tuple[bytes, str]:
    """The `/embedded/settings` body and its ETag, the way the route serves it."""
    payload_dict = {
        **embedded_settings_payload(db, frame),
        "frame": embedded_frame_settings(frame),
        # The scene schedule ({"events": [...]}) — the device evaluates it
        # on-device (fos_schedule.c), same event model as the Pi scheduler.
        "schedule": frame.schedule if isinstance(frame.schedule, dict) else None,
    }
    payload = json.dumps(payload_dict, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return payload, embedded_payload_etag(payload)


def embedded_settings_etag(db: Session, frame: Frame) -> str:
    return embedded_settings_document(db, frame)[1]


def embedded_frame_settings(frame: Frame) -> dict:
    """Live frame settings the device polls once per render pass.

    Everything a frame is, minus what only the USB console provisions (Wi-Fi,
    backend URL, API key, frame id, panel, pins, SD wiring): the interval,
    name, render mode, the power-management flags from ``device_config``,
    rotation, time zone, the HTTP response cap, the GPIO button map, the
    device's own admin login and its HTTPS material — so a settings change
    takes effect on the next poll, and a board flashed with the stock release
    image finishes provisioning itself on its first sync. ``renderMode`` is
    serialized as the "local"/"remote" string the device parser
    (fos_settings.c) expects. ``gpioButtons`` rides along only when the
    backend holds a map (the cloud pushes the same list through
    ``set_settings``); until 2026-10-12 the Settings panel's GPIO buttons
    changed nothing on a provisioned board.
    """
    from app.tasks.embedded_firmware import (
        EMBEDDED_CPU_MODES,
        EMBEDDED_LED_TYPES,
        EMBEDDED_RENDER_REMOTE,
        embedded_device_config,
        embedded_render_mode_for_frame,
    )

    device_config = embedded_device_config(frame)

    def _bool_config(*keys: str) -> bool:
        for key in keys:
            value = device_config.get(key)
            if isinstance(value, bool):
                return value
        return False

    # Present-only power keys: battery wiring, the buzzer and check-in cadence
    # are often provisioned on the device itself (USB console hardware
    # presets), so the poll must stay silent about them unless the backend
    # actually holds a value — a default sent every poll would clobber the
    # device's own copy.
    def _optional_power_settings() -> dict:
        extra: dict[str, object] = {}
        for out_key, keys, kind in (
            ("deepSleepOnBattery", ("deepSleepOnBattery", "deep_sleep_on_battery"), "bool"),
            ("wakeCheckSeconds", ("wakeCheckSeconds", "wake_check_seconds"), "int"),
            ("awakeAfterInputSeconds", ("awakeAfterInputSeconds", "awake_after_input_seconds"), "int"),
            ("batteryPin", ("batteryPin", "battery_pin"), "int"),
            ("batteryDivider", ("batteryDivider", "battery_divider"), "float"),
            ("batteryEnablePin", ("batteryEnablePin", "battery_enable_pin"), "int"),
            ("buzzerPin", ("buzzerPin", "buzzer_pin"), "int"),
            ("buzzerToneHz", ("buzzerToneHz", "buzzer_tone_hz"), "int"),
            # Voice chat (docs/voice-chat.md): the microphone switch, and the
            # PDM microphone's pins (-1 = none; unset = the board's own).
            ("voiceChat", ("voiceChat", "voice_chat"), "bool"),
            ("touchBeep", ("touchBeep", "touch_beep"), "bool"),
            # The chip's clock (main.c, at boot: the device restarts for it).
            ("cpuMode", ("cpuMode", "cpu_mode"), "cpu_mode"),
            ("micClkPin", ("micClkPin", "mic_clk_pin"), "int"),
            ("micDataPin", ("micDataPin", "mic_data_pin"), "int"),
            ("micPwrPin", ("micPwrPin", "mic_pwr_pin"), "int"),
            # The status LED that follows the buzzer (fos_led.c): GPIO and kind.
            ("ledPin", ("ledPin", "led_pin"), "int"),
            ("ledType", ("ledType", "led_type"), "led_type"),
        ):
            for key in keys:
                value = device_config.get(key)
                if kind == "bool" and isinstance(value, bool):
                    extra[out_key] = value
                    break
                if kind == "int" and isinstance(value, int) and not isinstance(value, bool):
                    extra[out_key] = value
                    break
                if kind == "float" and isinstance(value, (int, float)) and not isinstance(value, bool):
                    extra[out_key] = float(value)
                    break
                if kind == "led_type" and isinstance(value, str) and value in EMBEDDED_LED_TYPES:
                    extra[out_key] = value
                    break
                if kind == "cpu_mode" and isinstance(value, str) and value in EMBEDDED_CPU_MODES:
                    extra[out_key] = value
                    break
        return extra

    return {
        "interval": float(frame.interval or 300),
        "name": frame.name or "",
        "renderMode": "remote" if embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE else "local",
        "deepSleep": _bool_config("deepSleep", "deep_sleep"),
        "wakeSchedule": _bool_config("wakeSchedule", "wake_schedule"),
        **_optional_power_settings(),
        **(
            {"gpioButtons": [dict(button) for button in frame.gpio_buttons if isinstance(button, dict)]}
            if isinstance(frame.gpio_buttons, list)
            else {}
        ),
        # The frame's event map (docs/events.md "Event map"): what its buttons
        # do whatever scene shows. Like gpioButtons, present only when the
        # backend holds one — the board's own preset applies otherwise. Kept
        # as compact JSON on the device and applied live, no restart.
        **(
            {"eventMap": normalize_event_map(frame.event_map)}
            if isinstance(getattr(frame, "event_map", None), list)
            else {}
        ),
        # 0/90/180/270 — the firmware restarts itself to re-init the renderer
        # when this changes (scene canvases are sized at init).
        "rotate": int(frame.rotate or 0) % 360,
        # Fallback fit for image consumers without their own placement.
        # Applied live on the device (no restart); default and validation in
        # embedded_scaling_mode_for_frame.
        "scalingMode": embedded_scaling_mode_for_frame(frame),
        # What a UI from a .tsx/.jsx app is laid out for, a panel this many
        # times smaller (docs/jsx-ui.md "Scale"); 0 = automatic from the
        # panel. Applied on the next render; older firmware ignores the key.
        "renderScale": embedded_render_scale_for_frame(frame),
        # The frame page behind the gear of the settings on the frame's screen
        # (docs/scene-settings.md "The frame page"); the console's
        # `settings_unlock` wins over false. Older firmware ignores the key.
        "frameSettingsOnScreen": frame.frame_settings_on_screen is not False,
        # frame.json's `colors` block (docs/asset-color-profiles.md): kept as
        # compact JSON on the device and applied live, no restart. Older
        # firmware ignores the key.
        "colors": frame.colors or {},
        # frame.json's `palette` ({colors, name?, colorNames?}): the colours
        # this panel really shows, which the device's packer dithers to
        # (fos_settings.c keeps the colour list alone, applied live). {} hands
        # the panel back its own table. The cloud sends it through
        # set_settings; until 2026-11-12 this pull never did.
        "palette": frame.palette if isinstance(frame.palette, dict) else {},
        # IANA zone name plus that zone's tzdata slice (app.utils.tz_slice,
        # ~1.5 KB): firmware from 2026.8.34 loads the slice into chrono and
        # keeps its own clock, QuickJS Date and the schedule in the zone
        # (fos_tz.h). Older firmware ignores both keys. The slice is omitted
        # for a zone tzdata does not know; the device then asks tz.frameos.net.
        "timeZone": (getattr(frame, "timezone", None) or "").strip(),
        "timeZoneData": tz_slice((getattr(frame, "timezone", None) or "").strip()),
        # The device matches schedule events in frame-local wall-clock time;
        # firmware without fos_tz applies this flat offset to UTC. Sent as
        # the CURRENT offset, so a DST shift propagates on the next poll.
        "utcOffsetMinutes": _frame_utc_offset_minutes(frame),
        # Cap on one HTTP response body the on-device runtime buffers for a
        # scene; the device restarts to apply it (read once at boot).
        "maxHttpResponseBytes": embedded_max_http_response_bytes_for_frame(frame),
        # The board's own web UI login. The device refuses enabled-without-
        # credentials, so the shape here matches its local POST route.
        "adminAuth": _embedded_admin_auth_settings(frame),
        # The frame's HTTPS listener and its PEM material — the one thing a
        # console line cannot carry (a PEM is kilobytes), so this pull is how
        # a stock release image gets it. Persisted on the device (NVS), and
        # the device restarts to (re)start the listener when any of it changes.
        "tls": _embedded_tls_settings(frame),
    }


def _embedded_admin_auth_settings(frame: Frame) -> dict:
    admin_auth = normalize_frame_admin_auth(frame.frame_admin_auth)
    return {
        "enabled": bool(admin_auth["enabled"] and admin_auth["user"] and admin_auth["pass"]),
        "user": admin_auth["user"] or "",
        "pass": admin_auth["pass"] or "",
    }


def _embedded_tls_settings(frame: Frame) -> dict:
    https_proxy = normalize_https_proxy(frame.https_proxy)
    certs = https_proxy.get("certs") if isinstance(https_proxy.get("certs"), dict) else {}
    return {
        "enable": bool(https_proxy.get("enable")),
        "port": int(https_proxy.get("port") or 8443),
        "cert": str(certs.get("server") or ""),
        "key": str(certs.get("server_key") or ""),
    }


def _frame_utc_offset_minutes(frame: Frame) -> int:
    tz_name = (getattr(frame, "timezone", None) or "").strip()
    if not tz_name:
        return 0
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo

        offset = datetime.now(ZoneInfo(tz_name)).utcoffset()
        return int(offset.total_seconds() // 60) if offset else 0
    except Exception:
        return 0


@api_public.get("/frames/{id:int}/embedded/settings")
async def api_embedded_device_settings(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
    if_none_match: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    # Same cheap-poll contract as /embedded/scenes: the ETag is the payload's
    # sha256, so an unchanged configuration costs the device a 304.
    payload, etag = embedded_settings_document(db, frame)
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers={"ETag": etag})
    return Response(content=payload, media_type="application/json",
                    headers={"ETag": etag})


# NOTE: Do NOT add a backend image proxy for device rendering here. Frames
# must fetch and render images independently of the backend. Oversized
# sources are fixed with better on-device streaming decode (see the rule in
# AGENTS.md and frameos/src/frameos/utils/image.nim). Proxies are acceptable
# for in-browser previews only, never for frames.


def _embedded_ota_platform(frame: Frame, platform: str | None) -> str:
    """The release image family the device asks for. Firmware since the
    signed release OTA names its own flash layout (fos_ota_platform);
    older firmware sends nothing and gets the frame's configured layout —
    which, for a board it was flashed to match, is the same answer.

    A frame whose release image is not an ESP32 one (the pico family's UF2
    is provisioning-only) has no OTA image under any name."""
    try:
        release = embedded_release_firmware_for_frame(frame)
    except ValueError:
        # Malformed platform/flash metadata: the layout the device names
        # itself still stands.
        release = None
    if release is not None and release["format"] != EMBEDDED_IMAGE_FORMAT_BIN:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="ota_image_not_published")
    if platform:
        return platform
    if release is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="ota_image_not_published")
    return str(release["asset"])


@api_public.get("/frames/{id:int}/embedded/ota/manifest")
async def api_embedded_device_ota_manifest(
    id: int,
    platform: str | None = Query(None),
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    """The latest release's OTA manifest, relayed (docs/cloud-frames.md
    "Signed OTA"): ``{platform, version, size, minisig, downloadUrl}``.

    Also carries a ``sha256`` identifier for firmware from before the signed
    release OTA (per-frame backend builds): that updater compares it against
    the sha of the image it last applied and downloads when they differ, so
    a stable per-release token is what moves those boards onto the release
    image — after which they verify like every other board.
    """
    frame = _embedded_frame_from_bearer(db, id, authorization)
    platform = _embedded_ota_platform(frame, platform)
    manifest = await latest_release_ota_manifest(
        platform, f"/api/frames/{frame.id}/embedded/ota/download?platform={platform}"
    )
    legacy_id = hashlib.sha256(f"{manifest['version']}:{platform}".encode("utf-8")).hexdigest()
    return Response(
        content=json.dumps({**manifest, "sha256": legacy_id}, separators=(",", ":")),
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=300"},
    )


@api_public.head("/frames/{id:int}/embedded/ota/download")
@api_public.get("/frames/{id:int}/embedded/ota/download")
async def api_embedded_device_ota_download(
    id: int,
    platform: str | None = Query(None),
    db: Session = Depends(get_db),
    authorization: str = Header(None),
    range: str | None = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    platform = _embedded_ota_platform(frame, platform)
    return await stream_latest_release_ota_image(platform, range_header=range)
