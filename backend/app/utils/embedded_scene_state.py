"""Scene state for embedded (ESP32) frames, held by the backend.

The ESP32 runtime keeps no scene state across a reset, and a battery frame
resets on every deep-sleep wake: state applied over HTTP ("Apply to active
scene") lasted one render, after which the scene came back with its defaults.
It also only reached the device while it happened to be awake.

A scene SWITCH made while the frame sleeps is held the same way: as a
one-shot request (`Frame.scene_request`) sent as headers on that pull, which
firmware since SCENE_REQUEST_FIRMWARE_VERSION applies once
(embedded/esp32/main/fos_scene_request.h).

So the backend keeps the last state applied per scene (`Frame.scene_states`)
and folds it into the field defaults of the `/embedded/scenes` payload. The
device already pulls that payload (ETag'd) on every pass, so a changed value
is picked up on the next wake whether or not the frame was reachable when it
was applied, and every later boot starts the scene with it. No firmware change
is involved: a field's `value` is what the interpreter seeds state with.
"""

from __future__ import annotations

import copy
import json
import uuid
from typing import Any

from app.models.frame import Frame
from app.utils.versions import version_tuple

STATE_EVENTS = ("setCurrentScene", "setSceneState")

# The first firmware that reads the scene-request headers.
SCENE_REQUEST_FIRMWARE_VERSION = "2026.10.5"
SCENE_REQUEST_ID_HEADER = "X-FrameOS-Scene-Request-Id"
SCENE_REQUEST_SCENE_HEADER = "X-FrameOS-Scene-Request-Scene"


def is_embedded_frame(frame: Frame) -> bool:
    return (getattr(frame, "mode", None) or "rpios") == "embedded"


def _scene_by_id(frame: Frame, scene_id: str) -> dict[str, Any] | None:
    for scene in frame.scenes or []:
        if isinstance(scene, dict) and scene.get("id") == scene_id:
            return scene
    return None


def _public_field_names(scene: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for field in scene.get("fields") or []:
        if isinstance(field, dict) and field.get("access") == "public":
            name = field.get("name")
            if isinstance(name, str) and name:
                names.add(name)
    return names


def _field_default(value: Any) -> str:
    """A state value as scene JSON spells a field default."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return str(value)


def record_scene_state(frame: Frame, scene_id: str | None, state: Any) -> dict[str, Any]:
    """Merge `state` into what the frame holds for `scene_id`. Only the
    scene's public fields are kept, as on the device. Returns what was
    recorded; the caller commits."""
    if not isinstance(scene_id, str) or not scene_id or not isinstance(state, dict):
        return {}
    scene = _scene_by_id(frame, scene_id)
    if scene is None:
        return {}
    public = _public_field_names(scene)
    applied = {key: value for key, value in state.items() if key in public and value is not None}
    if not applied:
        return {}
    # A new dict, so SQLAlchemy sees the JSON column change.
    stored = {
        key: dict(value)
        for key, value in (frame.scene_states or {}).items()
        if isinstance(value, dict) and _scene_by_id(frame, key) is not None
    }
    stored[scene_id] = {**stored.get(scene_id, {}), **applied}
    frame.scene_states = stored
    return applied


def scenes_with_state(frame: Frame) -> list[dict[str, Any]]:
    """The frame's scenes with the held state folded into field defaults."""
    scenes = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    states = frame.scene_states if isinstance(frame.scene_states, dict) else {}
    if not states:
        return scenes
    result: list[dict[str, Any]] = []
    for scene in scenes:
        state = states.get(scene.get("id"))
        if not isinstance(state, dict) or not state:
            result.append(scene)
            continue
        scene = copy.deepcopy(scene)
        for field in scene.get("fields") or []:
            if (
                isinstance(field, dict)
                and field.get("access") == "public"
                and field.get("name") in state
            ):
                field["value"] = _field_default(state[field["name"]])
        result.append(scene)
    return result


def overlay_states_record(frame: Frame, record: dict[str, Any]) -> dict[str, Any]:
    """The /states answer with the held state on top: what the frame shows
    after its next wake, and what the panel should show meanwhile (a sleeping
    frame answers from a cache, or with its defaults after a reset)."""
    if not is_embedded_frame(frame):
        return record
    held = frame.scene_states if isinstance(frame.scene_states, dict) else {}
    if not held:
        return record
    states = dict(record.get("states") or {})
    for scene_id, state in held.items():
        if isinstance(state, dict) and state and _scene_by_id(frame, scene_id) is not None:
            states[scene_id] = {**(states.get(scene_id) or {}), **state}
    return {**record, "states": states}


def firmware_applies_scene_requests(frame: Frame) -> bool:
    """Whether the firmware the frame last booted reads the scene-request
    headers. Unknown counts as no: an older frame would sleep on its old
    scene while the workspace said "queued"."""
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    last_boot = embedded.get("lastBoot") if isinstance(embedded.get("lastBoot"), dict) else {}
    reported = version_tuple(last_boot.get("frameosVersion"))
    required = version_tuple(SCENE_REQUEST_FIRMWARE_VERSION)
    return reported is not None and required is not None and reported >= required


def queue_scene_request(frame: Frame, scene_id: str) -> None:
    """Hold a switch to `scene_id` for the frame's next pull; the caller commits."""
    frame.scene_request = {"id": uuid.uuid4().hex, "sceneId": scene_id}


def clear_scene_request(frame: Frame) -> None:
    """A switch reached the frame live: an older held one must not undo it."""
    frame.scene_request = None


def scene_request_headers(frame: Frame) -> dict[str, str]:
    request = frame.scene_request if isinstance(frame.scene_request, dict) else {}
    request_id = request.get("id")
    scene_id = request.get("sceneId")
    if not isinstance(request_id, str) or not isinstance(scene_id, str):
        return {}
    if _scene_by_id(frame, scene_id) is None:
        return {}
    return {SCENE_REQUEST_ID_HEADER: request_id, SCENE_REQUEST_SCENE_HEADER: scene_id}


# --------------------------------------------------------------- queued deploys
#
# An embedded fast deploy is "these scenes and settings, live". The device
# pulls both (/embedded/scenes, /embedded/settings) at the start of every
# pass, so a deploy to a frame that is asleep, or has not checked in with this
# backend yet, needs no push to happen: it is queued, and counts as deployed
# when the device next pulls. The snapshot waits in Redis until then.

QUEUED_DEPLOY_TTL_SECONDS = 30 * 86400


def queued_deploy_key(frame_id: int) -> str:
    return f"frame:{frame_id}:embedded_deploy_queued"


async def queue_embedded_deploy(redis: Any, frame_id: int, snapshot: dict[str, Any]) -> None:
    await redis.set(
        queued_deploy_key(frame_id),
        json.dumps(snapshot, default=str),
        ex=QUEUED_DEPLOY_TTL_SECONDS,
    )


async def take_queued_deploy(redis: Any, frame_id: int) -> dict[str, Any] | None:
    """The queued snapshot, once: the device just pulled what it describes."""
    key = queued_deploy_key(frame_id)
    raw = await redis.get(key)
    if raw is None:
        return None
    await redis.delete(key)
    try:
        snapshot = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (TypeError, ValueError):
        return None
    return snapshot if isinstance(snapshot, dict) else None
