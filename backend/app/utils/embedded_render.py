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
from dataclasses import dataclass, field
from pathlib import Path

from app.models.frame import Frame
from app.utils.timezone import frame_timezone

REPO_ROOT = Path(__file__).resolve().parents[3]
RENDER_HARNESS = REPO_ROOT / "backend" / "tools" / "embedded_wasm_render.mjs"
RENDER_TIMEOUT_SECONDS = 30
# Renders are CPU-bound (a full QuickJS + pixie pass); two at a time keeps a
# fleet of polling thin clients from forking a Node per request. The queue
# behind those two slots is bounded too: past MAX_RENDER_WAITERS a request
# is refused with RenderQueueFull (the routes answer 503 + Retry-After) so a
# fleet polling faster than the backend renders parks a fixed number of
# coroutines, not one per poll for as long as the storm lasts.
RENDER_CONCURRENCY = 2
MAX_RENDER_WAITERS = 8
RENDER_RETRY_AFTER_SECONDS = 5
_render_semaphore = asyncio.Semaphore(RENDER_CONCURRENCY)
_render_waiters = 0


class RenderQueueFull(Exception):
    """Every render slot is busy and the wait queue is at its cap."""

    retry_after = RENDER_RETRY_AFTER_SECONDS


def render_queue_depth() -> int:
    return _render_waiters

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


# The harness reports the post-render scene state and any assets the scene
# saved (written back to the host asset store) on stderr, one line each:
# `__FRAMEOS_SCENE_STATE__{"sceneId":...,"state":...}` and
# `__FRAMEOS_SAVED_ASSETS__{"files":[...],"skippedOverBudget":n}`.
_STATE_MARKER = "__FRAMEOS_SCENE_STATE__"
_SAVED_ASSETS_MARKER = "__FRAMEOS_SAVED_ASSETS__"
# A render under a device ceiling (app/utils/device_limits.py) that had an
# allocation refused: `__FRAMEOS_OUT_OF_MEMORY__{"refusedBytes":...,"usedBytes":...}`.
_OUT_OF_MEMORY_MARKER = "__FRAMEOS_OUT_OF_MEMORY__"
# The scene's own log lines (onFrameosLog), one JSON payload each.
_SCENE_LOG_PREFIX = "[scene] "
MAX_SCENE_LOG_LINES = 200


@dataclass
class SceneRender:
    """One render. ``rgba`` is None when it failed, and ``error`` says why;
    ``out_of_memory`` is set when the device ceiling refused an allocation."""

    rgba: bytes | None
    state: dict | None = None
    saved_assets: dict | None = None
    error: str | None = None
    out_of_memory: dict | None = None
    scene_logs: list[str] = field(default_factory=list)


def _parse_marker(stderr_text: str, marker: str) -> dict | None:
    for line in reversed(stderr_text.splitlines()):
        if not line.startswith(marker):
            continue
        try:
            payload = json.loads(line[len(marker):])
        except ValueError:
            return None
        return payload if isinstance(payload, dict) else None
    return None


async def render_scene(
    frame: Frame,
    width: int,
    height: int,
    *,
    scene_id: str | None = None,
    settings: dict | None = None,
    scenes_override: list | None = None,
    scene_states: dict | None = None,
    assets_dir: str | None = None,
    save_assets=None,
    assets_write_budget: int | None = None,
    device_limits: dict | None = None,
    control_events: list[dict] | None = None,
    device_input: dict | None = None,
    timeout: float = RENDER_TIMEOUT_SECONDS,
) -> SceneRender:
    """One frame of the scene, with its post-render state and saved assets.

    A None image means "no render available" (no scenes, no toolchain, render
    error, timeout) — the caller falls back to the diagnostic bitmap. Failures
    are expected operational states here, not exceptions: the device keeps
    polling, and a broken scene must not take the endpoint down with it.

    ``scene_states`` ({sceneId: state}) seeds backend-persisted scene state
    into the renderer; ``assets_dir`` is a host directory preloaded into the
    wasm filesystem at the frame's asset path (virtual frames), and files the
    scene saves there (saveAssets-enabled apps) are written back to it, up to
    ``assets_write_budget`` bytes; ``save_assets`` is the frame's saveAssets
    config forwarded to the runtime. The returned state is
    {"sceneId": ..., "state": {...}} and the saved-assets report is
    {"files": [...], "skippedOverBudget": n}; either is None when unavailable.
    ``device_limits`` (device_limits.esp32_device_limits) renders under a
    device's memory ceiling and as that device. ``control_events``
    ([{"name", "payload", "origin"}]) are the events a control plane sent a
    thin client since its last pull, and ``device_input`` ({"nowMs",
    "edges"}, embedded_device.embedded_device_input) the button edges it saw;
    the scene hears both before the render, the edges as its driver's
    (frameos/relayed_input.nim).
    """
    source = scenes_override if scenes_override is not None else frame.scenes
    scenes = [scene for scene in (source or []) if isinstance(scene, dict)]
    if not scenes:
        return SceneRender(None, error="There is no scene to render.")
    node = shutil.which("node")
    assets = wasm_assets_dir()
    if node is None or assets is None or not RENDER_HARNESS.is_file():
        return SceneRender(None, error="The scene renderer is not available (Node.js or the wasm runtime is missing).")

    network = frame.network if isinstance(frame.network, dict) else {}
    request = {
        "assetsDir": str(assets),
        "width": int(width),
        "height": int(height),
        "name": frame.name or f"frame {frame.id}",
        "timeZone": frame_timezone(frame.timezone),
        "settingsJson": json.dumps(settings or {}),
        "scenesJson": json.dumps(scenes, separators=(",", ":")),
        # Scene HTTP on this frame may reach the LAN only if the owner said so —
        # the same knob the device runtime reads (network.allowLocalNetworkAccess).
        # The renderer runs on the backend's network, so this is what keeps a
        # published scene away from the router, HA and the NAS.
        "allowLocalNetwork": network.get("allowLocalNetworkAccess") is True,
    }
    if scene_id:
        request["sceneId"] = scene_id
    if scene_states:
        request["statesJson"] = json.dumps(scene_states, separators=(",", ":"))
    if assets_dir:
        request["frameAssetsRoot"] = assets_dir
    if save_assets is not None:
        request["saveAssetsJson"] = json.dumps(save_assets)
    if assets_write_budget is not None:
        request["assetsWriteBudget"] = max(0, int(assets_write_budget))
    if device_limits:
        request["deviceLimits"] = device_limits
    if control_events:
        request["controlEventsJson"] = json.dumps(control_events, separators=(",", ":"))
    if device_input and device_input.get("edges"):
        request["deviceInputJson"] = json.dumps(device_input, separators=(",", ":"))

    expected = int(width) * int(height) * 4
    global _render_waiters
    if _render_semaphore.locked() and _render_waiters >= MAX_RENDER_WAITERS:
        raise RenderQueueFull()
    _render_waiters += 1
    try:
        await _render_semaphore.acquire()
    finally:
        _render_waiters -= 1
    try:
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
            return SceneRender(None, error=f"The scene did not render within {int(timeout)} seconds.")
    finally:
        _render_semaphore.release()

    stderr_text = stderr.decode("utf-8", errors="replace")
    scene_logs = [
        line[len(_SCENE_LOG_PREFIX):] for line in stderr_text.splitlines() if line.startswith(_SCENE_LOG_PREFIX)
    ][-MAX_SCENE_LOG_LINES:]
    if process.returncode != 0 or len(stdout) != expected:
        detail = stderr_text.strip().splitlines()
        tail = detail[-1] if detail else f"exit {process.returncode}"
        # Log through print (uvicorn stdout); the device-facing endpoint has
        # no frame log context worth spamming on every poll.
        print(f"embedded_render: frame {frame.id} scene render failed: {tail}")
        return SceneRender(
            None,
            error=tail.removeprefix("embedded_wasm_render: "),
            out_of_memory=_parse_marker(stderr_text, _OUT_OF_MEMORY_MARKER),
            scene_logs=scene_logs,
        )
    return SceneRender(
        stdout,
        state=_parse_marker(stderr_text, _STATE_MARKER),
        saved_assets=_parse_marker(stderr_text, _SAVED_ASSETS_MARKER),
        scene_logs=scene_logs,
    )


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
    save_assets=None,
    assets_write_budget: int | None = None,
    control_events: list[dict] | None = None,
    device_input: dict | None = None,
    scene_logs: list[str] | None = None,
    timeout: float = RENDER_TIMEOUT_SECONDS,
) -> tuple[bytes | None, dict | None, dict | None]:
    """render_scene as (RGBA bytes, post-render state, saved assets). The
    scene's own log lines are appended to ``scene_logs`` when one is given."""
    result = await render_scene(
        frame,
        width,
        height,
        scene_id=scene_id,
        settings=settings,
        scenes_override=scenes_override,
        scene_states=scene_states,
        assets_dir=assets_dir,
        save_assets=save_assets,
        assets_write_budget=assets_write_budget,
        control_events=control_events,
        device_input=device_input,
        timeout=timeout,
    )
    if scene_logs is not None:
        scene_logs.extend(result.scene_logs)
    return result.rgba, result.state, result.saved_assets


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
    rgba, _state, _saved = await render_scene_rgba_and_state(
        frame,
        width,
        height,
        scene_id=scene_id,
        settings=settings,
        scenes_override=scenes_override,
        timeout=timeout,
    )
    return rgba
