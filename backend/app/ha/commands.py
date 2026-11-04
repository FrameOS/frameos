"""
What Home Assistant sends back over MQTT, turned into one action on a frame.

Pure: `parse_topic` reads the frame out of a topic, `resolve_command` turns
a payload into an `Action` given the frame dict and its active scene.
Executing the action (the frame event route's dispatcher, the restart/reboot
tasks) is app.ha.sync's job.

Topics under the frame's base topic (docs/home-assistant.md):

- `set/scene`   the scene select: a scene label, name or id
- `set/display` the display switch: ON / OFF
- `press`       a button: refresh_image | render | next_scene | previous_scene |
                restart | reboot
- `command`     automations: {"event": name, "payload": {...}} or
                {"scene": label or id, "state": {...}}

A `state` on the command topic is typed by the scene's public fields where
it can be (Home Assistant templates make text; a boolean field wants a
boolean), and passed through where it cannot.

Event names on `command` are checked against the contract's `http:write`
origin (docs/events-contract.json, the frame's own API with the access key):
what a device on the network may ask of a frame, Home Assistant may too, and
no more. Restart and reboot are tasks, not events, and come as button presses;
so does refresh_image, which asks the backend for what the panel shows (the
image route's pull) and never the frame for a render.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from app.ha import discovery
from app.utils.events_contract_gen import REFUSED_BY_ORIGIN

TOPIC_RE = re.compile(r"^frameos/frame/(?P<project_id>\d+)/(?P<frame_id>\d+)/(?P<kind>command|press|set/(?P<what>[a-z_]+))$")
EVENT_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_:-]{0,63}$")
# What the network-facing frame API refuses with the access key; the same
# list for Home Assistant, which is on the network as far as a frame knows.
REFUSED_EVENTS = REFUSED_BY_ORIGIN["http:write"]
ON_WORDS = frozenset({"on", "true", "1", "yes"})
OFF_WORDS = frozenset({"off", "false", "0", "no"})


@dataclass(frozen=True)
class Topic:
    project_id: int
    frame_id: int
    kind: str  # "command" | "press" | "set"
    what: Optional[str] = None  # for "set": scene | display


@dataclass(frozen=True)
class Action:
    """One thing to do to the frame.

    kind:
      "event"         dispatch `event` with `payload` (the frame event route)
      "refresh_image" fetch what the panel shows and publish it again
      "restart"       the restart task
      "reboot"        the reboot task
      "error"         nothing; `message` says why
    """

    kind: str
    event: Optional[str] = None
    payload: dict = field(default_factory=dict)
    scene_id: Optional[str] = None
    message: str = ""
    summary: str = ""


def parse_topic(topic: str) -> Optional[Topic]:
    match = TOPIC_RE.match(topic or "")
    if not match:
        return None
    return Topic(
        project_id=int(match.group("project_id")),
        frame_id=int(match.group("frame_id")),
        kind="set" if match.group("kind").startswith("set/") else match.group("kind"),
        what=match.group("what"),
    )


def _text(payload: Any) -> str:
    if isinstance(payload, (bytes, bytearray)):
        return payload.decode("utf-8", errors="replace").strip()
    return str(payload or "").strip()


def _json_object(payload: Any) -> Optional[dict]:
    text = _text(payload)
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _error(message: str) -> Action:
    return Action(kind="error", message=message)


def _neighbour_scene(frame: dict, active_scene_id: Optional[str], step: int) -> Optional[str]:
    """The scene after (step 1) or before (step -1) the showing one, in the
    frame's order, wrapping around; the first scene when none is known."""
    scene_ids = [scene_id for scene_id, _label in discovery.scene_options(frame)]
    if not scene_ids:
        return None
    if active_scene_id not in scene_ids:
        return scene_ids[0]
    index = scene_ids.index(active_scene_id)
    return scene_ids[(index + step) % len(scene_ids)]


def _scene_fields(frame: dict, scene_id: Optional[str]) -> dict[str, dict]:
    for scene in discovery.frame_scenes(frame):
        if str(scene["id"]) == scene_id:
            return {str(f["name"]): f for f in discovery.scene_public_fields(scene)}
    return {}


def typed_state(frame: dict, scene_id: Optional[str], state: dict) -> dict:
    """`state` with each value in its field's declared type where the scene
    has such a field and the value fits; anything else as given."""
    fields = _scene_fields(frame, scene_id)
    typed: dict[str, Any] = {}
    for name, value in state.items():
        spec = fields.get(str(name))
        if spec is None:
            typed[name] = value
            continue
        try:
            typed[name] = discovery.coerce_field_value(spec, value)
        except (TypeError, ValueError):
            typed[name] = value
    return typed


def _scene_activation(frame: dict, scene_id: str, state: dict, summary: str) -> Action:
    payload: dict[str, Any] = {"sceneId": scene_id}
    if state:
        payload["state"] = typed_state(frame, scene_id, state)
    return Action(kind="event", event="setCurrentScene", payload=payload, scene_id=scene_id, summary=summary)


def resolve_command(topic: Topic, payload: Any, frame: dict, active_scene_id: Optional[str]) -> Action:
    text = _text(payload)

    if topic.kind == "press":
        if text == "refresh_image":
            return Action(kind="refresh_image", summary="refresh image")
        if text == "render":
            return Action(kind="event", event="render", payload={}, summary="re-render")
        if text in ("next_scene", "previous_scene"):
            target = _neighbour_scene(frame, active_scene_id, 1 if text == "next_scene" else -1)
            if target is None:
                return _error("The frame has no scenes to switch between")
            label = discovery.scene_label(frame, target)
            return _scene_activation(frame, target, {}, f"{text.replace('_', ' ')}: {label}")
        if text in ("restart", "reboot"):
            return Action(kind=text, summary=text)
        return _error(f"Unknown button {text!r}")

    if topic.kind == "set" and topic.what == "display":
        lowered = text.lower()
        if lowered in ON_WORDS:
            return Action(kind="event", event="turnOn", payload={}, summary="display on")
        if lowered in OFF_WORDS:
            return Action(kind="event", event="turnOff", payload={}, summary="display off")
        return _error(f"Display takes ON or OFF, not {text!r}")

    if topic.kind == "set" and topic.what == "scene":
        scene_id = discovery.scene_id_for(frame, text)
        if scene_id is None:
            return _error(f"No scene {text!r} on this frame")
        return _scene_activation(frame, scene_id, {}, f"scene: {discovery.scene_label(frame, scene_id)}")

    if topic.kind == "set":
        return _error(f"Unknown setting {topic.what!r}")

    # kind == "command": automations' free-form JSON.
    body = _json_object(payload)
    if body is None:
        return _error('A command is JSON: {"event": name, "payload": {...}} or {"scene": name, "state": {...}}')
    if body.get("scene") is not None:
        scene_id = discovery.scene_id_for(frame, str(body.get("scene")))
        if scene_id is None:
            return _error(f"No scene {body.get('scene')!r} on this frame")
        state = body.get("state")
        if state is not None and not isinstance(state, dict):
            return _error("`state` must be an object of field values")
        return _scene_activation(frame, scene_id, state or {}, f"scene: {discovery.scene_label(frame, scene_id)}")
    event = body.get("event")
    if not isinstance(event, str) or not EVENT_NAME_RE.match(event):
        return _error("`event` must name a scene event (render, setSceneState, turnOff, a custom event, ...)")
    if event in REFUSED_EVENTS:
        return _error(f"The event {event!r} is not available to Home Assistant")
    event_payload = body.get("payload")
    if event_payload is not None and not isinstance(event_payload, dict):
        return _error("`payload` must be an object")
    event_payload = dict(event_payload or {})
    if event == "setSceneState" and isinstance(event_payload.get("state"), dict):
        event_payload["state"] = typed_state(frame, active_scene_id, event_payload["state"])
    return Action(kind="event", event=event, payload=event_payload, summary=f"event {event}")
