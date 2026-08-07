"""Virtual frames: a backend-rendered frame with no hardware at all.

A frame whose platform is ``virtual`` renders exactly like the thin-client
boards — scenes run in the sandboxed wasm runtime server-side — but the
output is served as an image URL instead of a panel payload, for browser
kiosks, old tablets, digital-signage players, or anything else that can
show a picture. Self-hosted backends only.

- ``GET /api/frames/{id}/virtual/image?k=<server_api_key>`` — one PNG frame
  at the frame's configured size, optionally quantized to an e-ink-style
  palette (``device_config.colorMode``).
- ``GET /api/frames/{id}/virtual/page?k=<server_api_key>`` — a black
  full-screen HTML page that shows the image and refreshes it on the
  frame's interval. Paste into any kiosk browser and walk away.

The token is the frame's ``server_api_key`` — the same device credential
the hardware thin clients present as a Bearer header, carried in the query
string because kiosk browsers cannot set headers. Treat the URL like a
password; rotating the frame's server API key invalidates it.
"""

from __future__ import annotations

import io
from http import HTTPStatus

from fastapi import Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame
from app.redis import get_redis
from app.tasks.embedded_firmware import embedded_platform_spec_for_frame
from app.utils.embedded_render import render_scene_rgba

from . import api_public
from .embedded_device import (
    BWYR_PALETTE,
    SEVEN_COLOR_PALETTE,
    SPECTRA6_PALETTE,
    _active_scene_id,
    _nearest_palette_index,
    embedded_diagnostic_image,
    embedded_settings_payload,
)

VIRTUAL_DEFAULT_WIDTH = 800
VIRTUAL_DEFAULT_HEIGHT = 480
VIRTUAL_MIN_DIMENSION = 16
VIRTUAL_MAX_DIMENSION = 4096

# device_config.colorMode → how the rendered RGB image is quantized before
# encoding, to preview/e-ink-match the look of a physical panel.
VIRTUAL_COLOR_MODES = ("rgb", "bw", "gray4", "bwyr", "sevencolor", "spectra6")


def _virtual_frame(db: Session, frame_id: int, token: str | None) -> Frame:
    if not token:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Missing token")
    frame = db.get(Frame, frame_id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    if embedded_platform_spec_for_frame(frame)["family"] != "virtual":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not a virtual frame")
    # View-only credential: grants exactly "see the rendered frame", never the
    # device API surface. Rotate by regenerating device_config.viewToken.
    device_config = frame.device_config if isinstance(frame.device_config, dict) else {}
    view_token = device_config.get("viewToken")
    if not isinstance(view_token, str) or not view_token or token != view_token:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    return frame


def virtual_frame_dimensions(frame: Frame) -> tuple[int, int]:
    def clamp(value, fallback):
        if not isinstance(value, int) or isinstance(value, bool):
            return fallback
        return max(VIRTUAL_MIN_DIMENSION, min(VIRTUAL_MAX_DIMENSION, value))

    return clamp(frame.width, VIRTUAL_DEFAULT_WIDTH), clamp(frame.height, VIRTUAL_DEFAULT_HEIGHT)


def virtual_color_mode(frame: Frame) -> str:
    device_config = frame.device_config if isinstance(frame.device_config, dict) else {}
    mode = str(device_config.get("colorMode") or "rgb").strip().lower()
    return mode if mode in VIRTUAL_COLOR_MODES else "rgb"


def _quantize(image, mode: str):
    if mode == "rgb":
        return image
    if mode == "bw":
        return image.convert("1").convert("RGB")
    if mode == "gray4":
        gray = image.convert("L")
        return gray.point(lambda v: round(v * 3 / 255) * 85).convert("RGB")
    palette = {
        "bwyr": [p for p in BWYR_PALETTE],
        "sevencolor": [p for p in SEVEN_COLOR_PALETTE],
        # Palette index 4 is the "missing" Spectra slot; filter the sentinel.
        "spectra6": [p for p in SPECTRA6_PALETTE if p[0] <= 255],
    }[mode]
    rgb = image.convert("RGB")
    out = rgb.copy()
    pixels = out.load()
    source = rgb.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            pixels[x, y] = palette[_nearest_palette_index(source[x, y], palette)]
    return out


async def _virtual_frame_png(
    db: Session,
    redis,
    frame: Frame,
    *,
    scenes_override: list | None = None,
    scene_id_override: str | None = None,
) -> bytes:
    from PIL import Image

    width, height = virtual_frame_dimensions(frame)
    rgba = await render_scene_rgba(
        frame,
        width,
        height,
        scene_id=scene_id_override or await _active_scene_id(redis, frame),
        settings=embedded_settings_payload(db, frame),
        scenes_override=scenes_override,
    )
    if rgba is not None:
        image = Image.frombytes("RGBA", (width, height), rgba).convert("RGB")
    else:
        image = embedded_diagnostic_image(frame, width, height)
    image = _quantize(image, virtual_color_mode(frame))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


async def render_virtual_frame_png(db: Session, redis, frame: Frame) -> bytes:
    """Public entry for other endpoints (workspace image previews)."""
    return await _virtual_frame_png(db, redis, frame)


async def mark_virtual_frame_deployed(db: Session, redis, frame: Frame) -> None:
    """Record a successful 'deploy' so the workspace stops showing the frame
    as waiting-for-first-deploy: for a virtual frame, rendering IS deploying.
    Mirrors what the USB deploy completion records for embedded frames."""
    from datetime import datetime, timezone

    from app.models.frame import update_frame
    from app.utils.versions import current_frameos_version

    snapshot = frame.to_dict()
    snapshot.pop("last_successful_deploy", None)
    snapshot.pop("last_successful_deploy_at", None)
    version = current_frameos_version()
    if isinstance(version, str) and version:
        snapshot["frameos_version"] = version
    frame.status = "ready"
    frame.last_successful_deploy = snapshot
    frame.last_successful_deploy_at = datetime.now(timezone.utc)
    await update_frame(db, redis, frame)


async def refresh_virtual_frame_image(
    db: Session,
    redis,
    frame: Frame,
    *,
    scenes_override: list | None = None,
    scene_id: str | None = None,
) -> None:
    """Render now and publish into the frame image cache.

    The virtual equivalent of "the device rendered": deploy, scene
    activation, render-now and scene previews all reduce to this.
    ``scenes_override`` renders unsaved scenes (preview-on-frame) without
    persisting them.
    """
    from .frames import _store_frame_image

    png = await _virtual_frame_png(
        db, redis, frame, scenes_override=scenes_override, scene_id_override=scene_id
    )
    await _store_frame_image(db, redis, frame, png, scene_id=scene_id, publish_rendered=True)


@api_public.get("/frames/{id:int}/virtual/image")
async def api_virtual_frame_image(
    id: int,
    k: str = Query(None),
    db: Session = Depends(get_db),
    redis=Depends(get_redis),
):
    frame = _virtual_frame(db, id, k)
    png = await _virtual_frame_png(db, redis, frame)
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@api_public.get("/frames/{id:int}/virtual/page")
async def api_virtual_frame_page(
    id: int,
    k: str = Query(None),
    db: Session = Depends(get_db),
    redis=Depends(get_redis),
):
    frame = _virtual_frame(db, id, k)
    interval = frame.interval if isinstance(frame.interval, (int, float)) else 300
    interval = max(15, int(interval or 300))
    width, height = virtual_frame_dimensions(frame)
    # The page never embeds the key in rendered text, only in the image URL
    # it already arrived with; JS swaps the image in place so e-ink-style
    # updates do not flash white on kiosk browsers.
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{(frame.name or f"Frame {frame.id}")}</title>
<style>
  html, body {{ margin: 0; height: 100%; background: #000; }}
  body {{ display: flex; align-items: center; justify-content: center; }}
  img {{ max-width: 100vw; max-height: 100vh; object-fit: contain;
        image-rendering: auto; }}
</style></head>
<body>
<img id="frame" width="{width}" height="{height}"
     src="/api/frames/{frame.id}/virtual/image?k={k}" alt="">
<script>
  const img = document.getElementById('frame');
  const base = img.src;
  setInterval(() => {{
    const next = new Image();
    next.onload = () => {{ img.src = next.src; }};
    next.src = base + '&t=' + Date.now();
  }}, {interval * 1000});
</script>
</body></html>"""
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})
