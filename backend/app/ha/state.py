"""
What the Home Assistant sync remembers about a frame, in Redis, and how it
reads a frame's scene state.

- display power, `frame:{id}:display_power` ("on" / "off"): the frame's
  own `event:turnOn` / `event:turnOff` / `event:toggleScreen` log lines, the
  only trace of the panel's power the backend sees, and what Home Assistant
  asked for while the frame has not said otherwise;
- field values Home Assistant set for a scene that was not showing,
  `ha:frame:{id}:pending_state` (a hash, scene id → JSON): a frame applies
  state to the showing scene only, so they wait for that scene's next
  activation from Home Assistant;
- the discovery entities published for a frame, `ha:frame:{id}:entities`:
  the field entities depend on the scenes the frame had, and the ones a
  scene change leaves behind must be retracted by name.

Scene state itself comes from where the backend already keeps it: the
virtual/thin-client store, the device's `/states` cache, or the device.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from app.utils.events_contract_gen import SCENE_STATE_CHANGED_LOG_EVENTS

DISPLAY_LOG_EVENTS = ("event:turnOn", "event:turnOff", "event:toggleScreen")
FIELDS_LOG_EVENTS = SCENE_STATE_CHANGED_LOG_EVENTS
# A frame asked for its state over the network: give up before the sync
# loop stalls on an unplugged frame (its own connect timeouts are longer).
LIVE_STATES_TIMEOUT_SECONDS = 8.0


def display_power_key(frame_id: int) -> str:
    return f"frame:{frame_id}:display_power"


def pending_state_key(frame_id: int) -> str:
    return f"ha:frame:{frame_id}:pending_state"


def entities_key(frame_id: int) -> str:
    return f"ha:frame:{frame_id}:entities"


def _decode(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.decode(errors="replace") if isinstance(value, bytes) else str(value)


# ---- display power ----------------------------------------------------------------


async def get_display_power(redis, frame_id: int) -> Optional[str]:
    try:
        return _decode(await redis.get(display_power_key(frame_id)))
    except Exception:
        return None


async def set_display_power(redis, frame_id: int, on: bool) -> None:
    await redis.set(display_power_key(frame_id), "on" if on else "off")


async def note_display_log(redis, frame_id: int, event: str) -> bool:
    """A frame's own display log line; True when the power is now known."""
    if event == "event:turnOn":
        await set_display_power(redis, frame_id, True)
        return True
    if event == "event:turnOff":
        await set_display_power(redis, frame_id, False)
        return True
    if event == "event:toggleScreen":
        current = await get_display_power(redis, frame_id)
        if current in ("on", "off"):
            await set_display_power(redis, frame_id, current == "off")
            return True
    return False


# ---- pending field values -------------------------------------------------------


async def get_pending_states(redis, frame_id: int) -> dict[str, dict]:
    try:
        raw = await redis.hgetall(pending_state_key(frame_id))
    except Exception:
        return {}
    pending: dict[str, dict] = {}
    for scene_id, value in (raw or {}).items():
        try:
            parsed = json.loads(_decode(value) or "")
        except ValueError:
            continue
        if isinstance(parsed, dict):
            pending[_decode(scene_id) or ""] = parsed
    return pending


async def store_pending_state(redis, frame_id: int, scene_id: str, state: dict) -> dict:
    pending = await get_pending_states(redis, frame_id)
    merged = {**pending.get(scene_id, {}), **state}
    await redis.hset(pending_state_key(frame_id), scene_id, json.dumps(merged))
    return merged


async def clear_pending_state(redis, frame_id: int, scene_id: str) -> None:
    try:
        await redis.hdel(pending_state_key(frame_id), scene_id)
    except Exception:
        pass


# ---- published entities -------------------------------------------------------------


async def get_tracked_entities(redis, frame_id: int) -> set[str]:
    try:
        members = await redis.smembers(entities_key(frame_id))
    except Exception:
        return set()
    return {_decode(member) or "" for member in members or ()} - {""}


async def set_tracked_entities(redis, frame_id: int, keys: set[str]) -> None:
    key = entities_key(frame_id)
    await redis.delete(key)
    if keys:
        await redis.sadd(key, *sorted(keys))


# ---- scene state -----------------------------------------------------------------------


async def frame_scene_states(redis, frame, *, live: bool = True) -> dict[str, dict]:
    """{scene id: {field: value}} as the backend knows it. A virtual frame or
    a thin client answers from the store the backend renders from; any other
    frame from its `/states` cache, else (with `live`) from the device itself,
    briefly, else empty."""
    from app.api.frames import _frame_states_cache_key, _load_frame_states, _read_frame_states_cache
    from app.tasks.embedded_firmware import is_thin_client_frame, is_virtual_frame

    if is_virtual_frame(frame) or is_thin_client_frame(frame):
        from app.api.virtual_frame import get_virtual_scene_states

        try:
            return await get_virtual_scene_states(redis, frame)
        except Exception:
            return {}
    try:
        cached = await _read_frame_states_cache(redis, _frame_states_cache_key(frame.id))
    except Exception:
        cached = None
    if cached is not None and not cached.get("error"):
        states = cached.get("states")
        if isinstance(states, dict) and states:
            return {k: v for k, v in states.items() if isinstance(v, dict)}
    if not live:
        return {}
    try:
        record = await asyncio.wait_for(_load_frame_states(redis, frame), LIVE_STATES_TIMEOUT_SECONDS)
    except Exception:
        return {}
    states = record.get("states") if isinstance(record, dict) else None
    if not isinstance(states, dict):
        return {}
    return {k: v for k, v in states.items() if isinstance(v, dict)}
