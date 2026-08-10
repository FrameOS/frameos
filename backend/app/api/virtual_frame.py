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
import json
from http import HTTPStatus

from fastapi import Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame
from app.redis import get_redis
from app.tasks.embedded_firmware import embedded_platform_spec_for_frame
from app.utils import virtual_assets
from app.utils.embedded_render import render_scene_rgba_and_state

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

VIRTUAL_STATE_QUOTA_BYTES = 256 * 1024  # per frame, across all scenes

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


# --------------------------------------------------------------- scene state
#
# A device keeps scene state in the running process and persists chosen
# fields to disk; a virtual frame's renderer is a fresh wasm process every
# time, so the backend is the memory: per-scene state lives in redis (no
# TTL, same as frame:{id}:active_scene) and is injected into the renderer on
# every pass, then read back after the render so state the scene itself
# changed sticks too.


def _virtual_states_key(frame_id: int) -> str:
    return f"frame:{frame_id}:virtual:scene_states"


def _scene_by_id(frame: Frame, scene_id: str | None) -> dict | None:
    if not scene_id:
        return None
    for scene in frame.scenes or []:
        if isinstance(scene, dict) and scene.get("id") == scene_id:
            return scene
    return None


def _scene_fields(scene: dict) -> list[dict]:
    fields = scene.get("fields")
    return [f for f in fields if isinstance(f, dict) and f.get("name")] if isinstance(fields, list) else []


def _settable_field_names(scene: dict) -> set[str]:
    # Mirrors the interpreter's publicStateFields: fields without an explicit
    # access default to public.
    return {f["name"] for f in _scene_fields(scene) if f.get("access") != "private"}


def _storable_field_names(scene: dict) -> set[str]:
    # What survives between renders: everything settable plus fields the
    # scene marked persist=disk (the device's across-restarts contract).
    return _settable_field_names(scene) | {
        f["name"] for f in _scene_fields(scene) if f.get("persist") == "disk"
    }


async def get_virtual_scene_states(redis, frame: Frame) -> dict[str, dict]:
    raw = await redis.get(_virtual_states_key(frame.id))
    if not raw:
        return {}
    try:
        payload = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, UnicodeDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        scene_id: state
        for scene_id, state in payload.items()
        if isinstance(scene_id, str) and isinstance(state, dict)
    }


async def _save_virtual_scene_states(redis, frame: Frame, states: dict[str, dict]) -> None:
    serialized = json.dumps(states, separators=(",", ":"))
    if len(serialized) > VIRTUAL_STATE_QUOTA_BYTES:
        raise HTTPException(
            status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            detail=f"Scene state exceeds {VIRTUAL_STATE_QUOTA_BYTES} bytes",
        )
    await redis.set(_virtual_states_key(frame.id), serialized)


async def resolve_virtual_scene_id(redis, frame: Frame, scene_id: str | None = None) -> str | None:
    """The scene an event or render targets: explicit id, else the
    workspace-activated scene, else the frame's first scene."""
    if scene_id:
        return scene_id
    active = await _active_scene_id(redis, frame)
    if active:
        return active
    for scene in frame.scenes or []:
        if isinstance(scene, dict) and scene.get("id"):
            return scene["id"]
    return None


async def apply_virtual_scene_state(redis, frame: Frame, scene_id: str | None, state: dict) -> None:
    """Merge a setSceneState/setCurrentScene state payload, keeping only the
    scene's public fields — the same filter the device runtime applies."""
    scene = _scene_by_id(frame, scene_id)
    if scene is None or not isinstance(state, dict):
        return
    allowed = _settable_field_names(scene)
    field_types = {f["name"]: f.get("type") for f in _scene_fields(scene)}
    accepted = {}
    for key, value in state.items():
        if key not in allowed:
            continue
        # Control forms deliver json fields as strings; parse them like
        # applyPublicStateFromPayload does on the device.
        if field_types.get(key) == "json" and isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        accepted[key] = value
    if not accepted:
        return
    states = await get_virtual_scene_states(redis, frame)
    states[scene_id] = {**states.get(scene_id, {}), **accepted}
    await _save_virtual_scene_states(redis, frame, states)


async def store_rendered_scene_state(redis, frame: Frame, scene_id: str | None, state: dict) -> None:
    """Persist the state the renderer reported after a pass (defaults now
    evaluated, plus anything the scene's own logic changed)."""
    scene = _scene_by_id(frame, scene_id)
    if scene is None or not isinstance(state, dict):
        return
    storable = _storable_field_names(scene)
    filtered = {key: value for key, value in state.items() if key in storable}
    states = await get_virtual_scene_states(redis, frame)
    if states.get(scene_id) == filtered:
        return
    states[scene_id] = filtered
    try:
        await _save_virtual_scene_states(redis, frame, states)
    except HTTPException:
        # An oversized render-produced state must not fail the image request;
        # the previous stored state simply stays.
        pass


async def virtual_frame_states_payload(redis, frame: Frame) -> dict:
    """The `/states` shape a physical frame serves: current scene + per-scene
    public state, straight from the backend store."""
    states = await get_virtual_scene_states(redis, frame)
    scene_id = await resolve_virtual_scene_id(redis, frame)
    return {"sceneId": scene_id or "", "states": states}


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
    from PIL import Image

    if mode == "rgb":
        return image
    if mode == "bw":
        # convert("1") applies Floyd-Steinberg by default.
        return image.convert("1").convert("RGB")
    if mode == "gray4":
        palette = [(v, v, v) for v in (0, 85, 170, 255)]
    else:
        palette = {
            "bwyr": list(BWYR_PALETTE),
            "sevencolor": list(SEVEN_COLOR_PALETTE),
            # Palette index 4 is the "missing" Spectra slot; filter the sentinel.
            "spectra6": [p for p in SPECTRA6_PALETTE if p[0] <= 255],
        }[mode]
    # Floyd-Steinberg dither against the panel palette — nearest-color alone
    # looks terrible on photographic content.
    palette_image = Image.new("P", (1, 1))
    flat = [channel for color in palette for channel in color]
    palette_image.putpalette(flat + flat[:3] * (256 - len(palette)))
    return image.convert("RGB").quantize(
        palette=palette_image, dither=Image.Dither.FLOYDSTEINBERG
    ).convert("RGB")


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
    scene_states = await get_virtual_scene_states(redis, frame)
    assets_dir = virtual_assets.frame_assets_dir(frame)
    rgba, rendered_state, saved_assets = await render_scene_rgba_and_state(
        frame,
        width,
        height,
        scene_id=scene_id_override or await _active_scene_id(redis, frame),
        settings=embedded_settings_payload(db, frame),
        scenes_override=scenes_override,
        scene_states=scene_states,
        assets_dir=str(assets_dir),
        save_assets=frame.save_assets,
        assets_write_budget=max(
            0, virtual_assets.quota_bytes(frame) - virtual_assets.usage_bytes(frame)
        ),
    )
    if saved_assets is not None and saved_assets.get("files"):
        # Scene apps saved new assets (OpenAI images, downloaded photos):
        # drop the cached listing so the workspace sees them.
        from .frames import _invalidate_frame_assets_cache

        await _invalidate_frame_assets_cache(
            redis, frame, frame.assets_path or "/srv/assets"
        )
    # Previews of unsaved scenes must not clobber the stored state; neither
    # may a render whose state seeding failed (old wasm bundle without the
    # set_scene_state export) — its readback is just scene defaults.
    if (
        rendered_state is not None
        and scenes_override is None
        and rendered_state.get("seeded", True)
    ):
        await store_rendered_scene_state(
            redis, frame, rendered_state.get("sceneId"), rendered_state.get("state")
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
    import time

    from app.models.log import new_log as log

    from .frames import _store_frame_image

    width, height = virtual_frame_dimensions(frame)
    shown_scene = scene_id or await _active_scene_id(redis, frame)
    source = scenes_override if scenes_override is not None else frame.scenes
    scene_ids = [s.get("id") for s in (source or []) if isinstance(s, dict)]
    if not shown_scene and scene_ids:
        shown_scene = scene_ids[0]

    # Same structured event lines a physical frame's runtime emits, so the
    # workspace log views and status indicators treat virtual renders
    # exactly like device renders.
    await log(db, redis, int(frame.id), "webhook", json.dumps({
        "event": "render:scene",
        "sceneId": shown_scene,
        "width": width,
        "height": height,
        **({"preview": True} if scenes_override is not None else {}),
    }, separators=(",", ":")))
    started = time.monotonic()
    png = await _virtual_frame_png(
        db, redis, frame, scenes_override=scenes_override, scene_id_override=scene_id
    )
    # Store under the scene that was actually shown so the per-scene
    # snapshot lands in the SceneImage table and survives restarts.
    await _store_frame_image(db, redis, frame, png, scene_id=shown_scene, publish_rendered=True)
    await log(db, redis, int(frame.id), "webhook", json.dumps({
        "event": "render:done",
        "sceneId": shown_scene,
        "ms": round((time.monotonic() - started) * 1000, 1),
    }, separators=(",", ":")))


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
