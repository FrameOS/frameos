"""What the provider hub hears from a frame, into the backend's own tables.

The provider sidecar (cloud/apps/backend-provider) is FrameOS Cloud's frame
hub; it keeps what a frame reports in its own Postgres and fans it out on its
browser sockets, which is how the cloud's workspace follows a frame. The
backend follows the same fleet socket (`/api/frames/updates`, with a session
the bridge mints for the backend's account) and lands every event where it
keeps the same facts for every other frame:

- `update_frame`: the link's connectivity, version, hardware, state and
  scene checksum; the frame's deploy progress, firmware update and sleep
  forecast (the hub folds those exactly as the backend would); the states
  cache. Deploys the device has now acked become the frame's baseline, and
  the scenes a frame joined with become its scene list.
- `new_log`: models/log.py process_log, as for a frame posting /api/log.
- `new_metrics`: the metrics table.

One mirror per install: it runs in the arq worker, the backend's singleton
process (the Home Assistant and cloud sync services live there for the same
reason).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.config import config
from app.database import SessionLocal
from app.models.frame import Frame, update_frame
from app.models.frame_provider import FrameProviderLink
from app.models.log import new_log, process_log
from app.models.metrics import new_metrics
from app.utils import provider_bridge
from app.utils.provider_bridge import BridgeError
from app.utils.provider_frames import apply_hardware_to_frame

logger = logging.getLogger(__name__)

UPDATES_PATH = "/api/frames/updates"
MAX_STATE_BYTES = 64 * 1024


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed


def _frame_for_remote(db, remote_frame_id: Any) -> Optional[Frame]:
    if not isinstance(remote_frame_id, str):
        return None
    link = db.query(FrameProviderLink).filter_by(remote_frame_id=remote_frame_id).first()
    return link.frame if link is not None else None


async def apply_frame_update(db, redis, data: dict[str, Any]) -> None:
    """One `update_frame` from the hub (the cloud's frameSummary plus
    last_state / last_metrics) onto the backend's frame and link."""
    from app.api.frames import _frame_states_cache_key, _write_frame_states_cache
    from app.utils.provider_commands import record_settled_provider_deploys

    frame = _frame_for_remote(db, data.get("id"))
    link = frame.provider_link if frame is not None else None
    if frame is None or link is None:
        return
    link.connected = data.get("connected") is True
    seen = _parse_iso(data.get("last_seen_at"))
    if seen is not None:
        link.last_seen_at = seen
    version = data.get("frameos_version")
    if isinstance(version, str) and version:
        link.frameos_version = version[:64]
    hardware = data.get("hardware")
    if isinstance(hardware, dict):
        link.hardware = hardware
        apply_hardware_to_frame(frame, hardware)
    checksum = data.get("scenes_checksum")
    if isinstance(checksum, str) and len(checksum) <= 128:
        link.scenes_checksum = checksum
    state = data.get("last_state")
    if isinstance(state, dict) and len(json.dumps(state)) <= MAX_STATE_BYTES:
        link.last_state = state
    # The hub folds these with the same contracts the backend does
    # (deploy progress, firmware update narration, sleep forecast); its copy
    # is the one that saw the device.
    for column in ("deploy_progress", "firmware_update", "sleep_reason"):
        if column in data:
            setattr(frame, column, data.get(column))
    for column in ("next_wake_at", "next_render_at"):
        if column in data:
            setattr(frame, column, _parse_iso(data.get(column)))
    db.commit()

    if isinstance(state, dict):
        scene_id = state.get("active_scene") if isinstance(state.get("active_scene"), str) else ""
        by_scene = {key: value for key, value in state.items() if key != "active_scene"}
        if scene_id and not any(isinstance(value, dict) for value in by_scene.values()):
            by_scene = {scene_id: by_scene}
        if scene_id:
            await redis.set(f"frame:{frame.id}:active_scene", scene_id)
        await _write_frame_states_cache(
            redis, _frame_states_cache_key(frame.id), {"sceneId": scene_id or "", "states": by_scene}, fetched_at=time.time()
        )
    await update_frame(db, redis, frame)
    if link.connected:
        try:
            await record_settled_provider_deploys(db, redis, frame)
        except Exception as exc:  # noqa: BLE001 - the bridge may be restarting
            logger.warning("provider mirror: deploy record for frame %s failed: %s", frame.id, exc)
        await _adopt_device_scenes(db, redis, frame)


async def _adopt_device_scenes(db, redis, frame: Frame) -> None:
    """The scenes a frame already ran when it enrolled (the hub asked with
    `scenes_get`) become its scene list here, unless the owner has given it
    scenes since — what adopting a card does."""
    link = frame.provider_link
    if link is None or not link.remote_frame_id:
        return
    decided_key = f"frameos:provider_device_scenes_decided:{link.remote_frame_id}"
    if await redis.get(decided_key):
        return
    if isinstance(frame.scenes, list) and frame.scenes:
        # The backend has scenes for it: nothing to import, and the hub
        # stops asking the frame for its own (shouldRequestDeviceScenes).
        try:
            await provider_bridge.device_scenes_imported(link.remote_frame_id)
            await redis.set(decided_key, "1", ex=7 * 24 * 3600)
        except BridgeError:
            pass
        return
    try:
        document = await provider_bridge.device_scenes(link.remote_frame_id)
    except BridgeError:
        return
    scenes = document.get("scenes") if isinstance(document, dict) else None
    if not isinstance(scenes, list) or not scenes:
        return
    frame.scenes = [scene for scene in scenes if isinstance(scene, dict)]
    await update_frame(db, redis, frame)
    try:
        await provider_bridge.device_scenes_imported(link.remote_frame_id)
        await redis.set(decided_key, "1", ex=7 * 24 * 3600)
    except BridgeError:
        pass
    await new_log(
        db, redis, int(frame.id), "stdinfo",
        f"Imported the {len(frame.scenes)} scene{'' if len(frame.scenes) == 1 else 's'} the frame already ran",
    )


async def apply_new_log(db, redis, data: dict[str, Any]) -> None:
    frame = _frame_for_remote(db, data.get("frame_id"))
    if frame is None:
        return
    try:
        payload = json.loads(data.get("line") or "null")
    except (TypeError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        payload = {"event": "log", "message": str(data.get("line"))}
    stamp = _parse_iso(data.get("timestamp"))
    at = stamp.replace(tzinfo=timezone.utc).timestamp() if stamp else time.time()
    await process_log(db, redis, frame, [at, payload])


async def apply_new_metrics(db, redis, data: dict[str, Any]) -> None:
    frame = _frame_for_remote(db, data.get("frame_id"))
    metrics = data.get("metrics")
    if frame is None or not isinstance(metrics, dict) or not metrics:
        return
    await new_metrics(db, redis, int(frame.id), metrics)


HANDLERS = {
    "update_frame": apply_frame_update,
    "new_log": apply_new_log,
    "new_metrics": apply_new_metrics,
}


async def apply_event(redis, message: dict[str, Any]) -> None:
    handler = HANDLERS.get(str(message.get("event")))
    data = message.get("data")
    if handler is None or not isinstance(data, dict):
        return
    db = SessionLocal()
    try:
        await handler(db, redis, data)
    except Exception as exc:  # noqa: BLE001 - one bad event must not stop the mirror
        logger.warning("provider mirror: %s failed: %s", message.get("event"), exc)
        db.rollback()
    finally:
        db.close()


class ProviderMirror:
    """Follow the hub's fleet socket for as long as the worker lives,
    redialing with backoff (and with a fresh session when one expires)."""

    async def run(self) -> None:
        from app.redis import create_redis_connection

        redis = create_redis_connection()
        backoff = 1.0
        while True:
            try:
                session = await provider_bridge.browser_session()
                url = config.FRAMEOS_PROVIDER_HUB_URL.rstrip("/") + UPDATES_PATH
                async with connect(url, additional_headers={"Cookie": session["cookie"]}, max_size=8 * 1024 * 1024) as socket:
                    backoff = 1.0
                    logger.info("provider mirror: following the hub's frame updates")
                    async for raw in socket:
                        try:
                            message = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        if isinstance(message, dict):
                            await apply_event(redis, message)
            except asyncio.CancelledError:
                raise
            except (BridgeError, ConnectionClosed, OSError) as exc:
                logger.info("provider mirror: hub not reachable (%s); retrying in %.0fs", exc, backoff)
            except Exception as exc:  # noqa: BLE001 - never die, redial
                logger.warning("provider mirror: %s; retrying in %.0fs", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


provider_mirror = ProviderMirror()
