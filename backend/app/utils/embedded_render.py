"""Server-side scene rendering for ESP32 thin clients.

PSRAM-less boards (ESP32-C3: TRMNL OG/BWRY, XTEINK X4) cannot run the
on-device renderer, so the backend renders their scenes and the device blits
the result. The rendering happens inside the same emscripten wasm bundle the
browser live-preview uses (frameos/tools/build_wasm.sh), hosted by a short-
lived Node subprocess (backend/tools/embedded_wasm_render.mjs).

Sandbox posture: user scene code (QuickJS) executes inside the wasm module,
never natively on the backend. The wasm runtime has no filesystem or socket
access; its HTTP hook goes through the harness' synchronous fetch shim,
giving scene apps the same outbound HTTP a physical frame has (the cloud
metadata address is blocked). The subprocess itself is bounded by a
wall-clock timeout and a concurrency cap so render storms cannot pile up
Node processes.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path

from app.models.frame import Frame
from app.utils.timezone import frame_timezone

REPO_ROOT = Path(__file__).resolve().parents[3]
RENDER_HARNESS = REPO_ROOT / "backend" / "tools" / "embedded_wasm_render.mjs"
RENDER_TIMEOUT_SECONDS = 30
# Renders are CPU-bound (a full QuickJS + pixie pass); two at a time keeps a
# fleet of polling thin clients from forking a Node per request.
_render_semaphore = asyncio.Semaphore(2)

_WASM_ASSET_DIRS = (
    # Built by frameos/tools/build_wasm.sh (dev checkouts and the Docker
    # app-builder stage, which lands them in frontend/dist via Vite's public/).
    REPO_ROOT / "frontend" / "public" / "frameos-wasm",
    REPO_ROOT / "frontend" / "dist" / "frameos-wasm",
    # npm-package layout (frameos/wasm `npm run build`).
    REPO_ROOT / "frameos" / "wasm" / "dist" / "assets",
)


def wasm_assets_dir() -> Path | None:
    override = os.environ.get("FRAMEOS_WASM_DIR")
    candidates = ([Path(override)] if override else []) + list(_WASM_ASSET_DIRS)
    for candidate in candidates:
        if (candidate / "frameos.js").is_file() and (candidate / "frameos.wasm").is_file():
            return candidate
    return None


def thin_client_renderer_available() -> bool:
    return shutil.which("node") is not None and wasm_assets_dir() is not None and RENDER_HARNESS.is_file()


# The harness reports the post-render scene state on stderr as one
# `__FRAMEOS_SCENE_STATE__{"sceneId":...,"state":...}` line.
_STATE_MARKER = "__FRAMEOS_SCENE_STATE__"


def _parse_rendered_state(stderr: bytes) -> dict | None:
    for line in reversed(stderr.decode("utf-8", errors="replace").splitlines()):
        if not line.startswith(_STATE_MARKER):
            continue
        try:
            payload = json.loads(line[len(_STATE_MARKER):])
        except ValueError:
            return None
        return payload if isinstance(payload, dict) else None
    return None


async def render_scene_rgba_and_state(
    frame: Frame,
    width: int,
    height: int,
    *,
    scene_id: str | None = None,
    settings: dict | None = None,
    scenes_override: list | None = None,
    scene_states: dict | None = None,
    assets_dir: str | None = None,
    timeout: float = RENDER_TIMEOUT_SECONDS,
) -> tuple[bytes | None, dict | None]:
    """One frame of the scene as (width*height*4 RGBA bytes, post-render state).

    A None image means "no render available" (no scenes, no toolchain, render
    error, timeout) — the caller falls back to the diagnostic bitmap. Failures
    are expected operational states here, not exceptions: the device keeps
    polling, and a broken scene must not take the endpoint down with it.

    ``scene_states`` ({sceneId: state}) seeds backend-persisted scene state
    into the renderer; ``assets_dir`` is a host directory preloaded into the
    wasm filesystem at the frame's asset path (virtual frames). The returned
    state is {"sceneId": ..., "state": {...}} or None when unavailable.
    """
    source = scenes_override if scenes_override is not None else frame.scenes
    scenes = [scene for scene in (source or []) if isinstance(scene, dict)]
    if not scenes:
        return None, None
    node = shutil.which("node")
    assets = wasm_assets_dir()
    if node is None or assets is None or not RENDER_HARNESS.is_file():
        return None, None

    request = {
        "assetsDir": str(assets),
        "width": int(width),
        "height": int(height),
        "name": frame.name or f"frame {frame.id}",
        "timeZone": frame_timezone(frame.timezone),
        "settingsJson": json.dumps(settings or {}),
        "scenesJson": json.dumps(scenes, separators=(",", ":")),
    }
    if scene_id:
        request["sceneId"] = scene_id
    if scene_states:
        request["statesJson"] = json.dumps(scene_states, separators=(",", ":"))
    if assets_dir:
        request["frameAssetsRoot"] = assets_dir

    expected = int(width) * int(height) * 4
    async with _render_semaphore:
        process = await asyncio.create_subprocess_exec(
            node,
            str(RENDER_HARNESS),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps(request).encode("utf-8")),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return None, None

    if process.returncode != 0 or len(stdout) != expected:
        detail = stderr.decode("utf-8", errors="replace").strip().splitlines()
        tail = detail[-1] if detail else f"exit {process.returncode}"
        # Log through print (uvicorn stdout); the device-facing endpoint has
        # no frame log context worth spamming on every poll.
        print(f"embedded_render: frame {frame.id} scene render failed: {tail}")
        return None, None
    return stdout, _parse_rendered_state(stderr)


async def render_scene_rgba(
    frame: Frame,
    width: int,
    height: int,
    *,
    scene_id: str | None = None,
    settings: dict | None = None,
    scenes_override: list | None = None,
    timeout: float = RENDER_TIMEOUT_SECONDS,
) -> bytes | None:
    """Image-only wrapper around render_scene_rgba_and_state (thin clients)."""
    rgba, _state = await render_scene_rgba_and_state(
        frame,
        width,
        height,
        scene_id=scene_id,
        settings=settings,
        scenes_override=scenes_override,
        timeout=timeout,
    )
    return rgba
