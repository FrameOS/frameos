"""
What the Home Assistant sync remembers about a frame, in Redis, and how it
reads a frame's scene state.

- display power, `frame:{id}:display_power` ("on" / "off"): the frame's
  own `event:turnOn` / `event:turnOff` / `event:toggleScreen` log lines, the
  only trace of the panel's power the backend sees, and what Home Assistant
  asked for while the frame has not said otherwise.

Scene state itself comes from where the backend already keeps it: the
virtual/thin-client store, the device's `/states` cache, or the device.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from app.utils.events_contract_gen import SCENE_STATE_CHANGED_LOG_EVENTS

DISPLAY_LOG_EVENTS = ("event:turnOn", "event:turnOff", "event:toggleScreen")
FIELDS_LOG_EVENTS = SCENE_STATE_CHANGED_LOG_EVENTS
# A frame asked for its state over the network: give up before the sync
# loop stalls on an unplugged frame (its own connect timeouts are longer).
LIVE_STATES_TIMEOUT_SECONDS = 8.0


def display_power_key(frame_id: int) -> str:
    return f"frame:{frame_id}:display_power"


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
