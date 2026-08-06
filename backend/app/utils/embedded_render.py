"""Server-side scene rendering for ESP32 thin clients.

PSRAM-less boards (ESP32-C3: TRMNL OG/BWRY, XTEINK X4) cannot run the
on-device renderer, so the backend renders their scenes and the device blits
the result. The rendering happens inside the same emscripten wasm bundle the
browser live-preview uses (frameos/tools/build_wasm.sh), hosted by a short-
lived Node subprocess (backend/tools/embedded_wasm_render.mjs).

Sandbox posture: user scene code (QuickJS) executes inside the wasm module,
never natively on the backend. The wasm runtime has no filesystem or socket
access; its only HTTP hook is a browser-style synchronous XHR bridge, which
does not exist under Node — so outbound requests from scene apps fail closed.
The subprocess itself is bounded by a wall-clock timeout and a concurrency
cap so render storms cannot pile up Node processes.
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


async def render_scene_rgba(
    frame: Frame,
    width: int,
    height: int,
    *,
    scene_id: str | None = None,
    settings: dict | None = None,
    timeout: float = RENDER_TIMEOUT_SECONDS,
) -> bytes | None:
    """One frame of the scene as width*height*4 RGBA bytes, or None.

    None means "no render available" (no scenes, no toolchain, render error,
    timeout) — the caller falls back to the diagnostic bitmap. Failures are
    expected operational states here, not exceptions: the device keeps
    polling, and a broken scene must not take the endpoint down with it.
    """
    scenes = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    if not scenes:
        return None
    node = shutil.which("node")
    assets = wasm_assets_dir()
    if node is None or assets is None or not RENDER_HARNESS.is_file():
        return None

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
            return None

    if process.returncode != 0 or len(stdout) != expected:
        detail = stderr.decode("utf-8", errors="replace").strip().splitlines()
        tail = detail[-1] if detail else f"exit {process.returncode}"
        # Log through print (uvicorn stdout); the device-facing endpoint has
        # no frame log context worth spamming on every poll.
        print(f"embedded_render: frame {frame.id} scene render failed: {tail}")
        return None
    return stdout
