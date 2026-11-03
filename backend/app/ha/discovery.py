"""
Topic and payload builders for the Home Assistant integration.

Pure functions only: everything here maps FrameOS state (frame dicts as
produced by Frame.to_dict()) to MQTT discovery topics and JSON payloads,
so it can be tested without a broker. Publishing lives in app.ha.sync,
what Home Assistant sends back is read by app.ha.commands.

What a frame is in Home Assistant (docs/home-assistant.md):

- an `image` with the latest render, `sensor`s for status, scene and last
  seen;
- a `select` of its scenes (pick one = `setCurrentScene`), a `switch` for
  the display (`turnOn` / `turnOff`), `button`s for refresh, next and
  previous scene, restart and reboot.

The scene showing has its public field values as the scene sensor's
attributes (the `fields` topic), never as entities of their own: a frame has
many scenes and a scene many fields, and a thousand entities is not a Home
Assistant integration. Parameters go the other way through the `command`
topic ({"scene": …, "state": {…}}, or a `setSceneState` event).

Every command entity publishes to a topic under the frame's base topic;
`frame_command_subscriptions()` lists the filters the sync subscribes to.
"""

import json
from typing import Any, Optional

from app.utils.refresh_interval import resolve_refresh_interval

DISCOVERY_PREFIX = "homeassistant"
AVAILABILITY_TOPIC = "frameos/status"
HA_EVENT_TYPE = "frameos_event"

# Frame log events that are noise for Home Assistant automations. Everything
# else (render lifecycle, bootup, buttons, custom scene events, ...) is
# forwarded to the HA event bus and the frame's MQTT event topic.
SKIPPED_LOG_EVENTS = {"log", "debug", "metrics"}

# Buttons on the frame's device: (object_id, name, press payload, icon, entity_category)
FRAME_BUTTONS: tuple[tuple[str, str, str, str, Optional[str]], ...] = (
    ("refresh", "Refresh", "render", "mdi:refresh", None),
    ("next_scene", "Next scene", "next_scene", "mdi:skip-next", None),
    ("previous_scene", "Previous scene", "previous_scene", "mdi:skip-previous", None),
    ("restart", "Restart FrameOS", "restart", "mdi:restart", "config"),
    ("reboot", "Reboot", "reboot", "mdi:power-cycle", "config"),
)
BUTTON_PRESS_PAYLOADS = frozenset(button[2] for button in FRAME_BUTTONS)

# Field types whose values the scene sensor's attributes carry. The rest
# (json, image, font, node, scene, path) are code, assets or wiring, not
# settings, and may be large.
ATTRIBUTE_FIELD_TYPES = frozenset({"boolean", "integer", "float", "select", "string", "text", "color", "date"})


def frame_node_id(project_id: int, frame_id: int) -> str:
    return f"frameos_{project_id}_{frame_id}"


def hub_node_id(project_id: int) -> str:
    return f"frameos_{project_id}"


def frame_base_topic(project_id: int, frame_id: int) -> str:
    return f"frameos/frame/{project_id}/{frame_id}"


def frame_state_topic(project_id: int, frame_id: int) -> str:
    return f"{frame_base_topic(project_id, frame_id)}/state"


def frame_image_topic(project_id: int, frame_id: int) -> str:
    return f"{frame_base_topic(project_id, frame_id)}/image"


def frame_event_topic(project_id: int, frame_id: int) -> str:
    return f"{frame_base_topic(project_id, frame_id)}/event"


def frame_fields_topic(project_id: int, frame_id: int) -> str:
    """Retained JSON {scene_id, scene, fields: {name: value}} for the scene
    showing: the scene sensor's attributes."""
    return f"{frame_base_topic(project_id, frame_id)}/fields"


def frame_command_topic(project_id: int, frame_id: int) -> str:
    """Free-form commands from automations: {"event": name, "payload": {...}}
    or {"scene": name or id, "state": {...}} (docs/home-assistant.md)."""
    return f"{frame_base_topic(project_id, frame_id)}/command"


def frame_press_topic(project_id: int, frame_id: int) -> str:
    return f"{frame_base_topic(project_id, frame_id)}/press"


def frame_set_topic(project_id: int, frame_id: int, what: str) -> str:
    """`scene` (the select), `display` (the switch)."""
    return f"{frame_base_topic(project_id, frame_id)}/set/{what}"


def frame_command_subscriptions() -> tuple[str, ...]:
    return ("frameos/frame/+/+/command", "frameos/frame/+/+/press", "frameos/frame/+/+/set/+")


def summary_state_topic(project_id: int) -> str:
    return f"frameos/frames/{project_id}/state"


def hub_device(project_id: int) -> dict:
    return {
        "identifiers": [hub_node_id(project_id)],
        "name": "FrameOS",
        "manufacturer": "FrameOS",
        "model": "FrameOS backend",
    }


def frame_device(frame: dict) -> dict:
    project_id, frame_id = frame["project_id"], frame["id"]
    device: dict[str, Any] = {
        "identifiers": [f"frameos_frame_{project_id}_{frame_id}"],
        "name": frame.get("name") or f"Frame {frame_id}",
        "manufacturer": "FrameOS",
        "model": frame.get("device") or "frame",
        "via_device": hub_node_id(project_id),
    }
    if frame.get("version"):
        device["sw_version"] = frame["version"]
    return device


# ---- scenes and fields ---------------------------------------------------------


def frame_scenes(frame: dict) -> list[dict]:
    return [scene for scene in frame.get("scenes") or [] if isinstance(scene, dict) and scene.get("id")]


def scene_options(frame: dict) -> list[tuple[str, str]]:
    """(scene id, label) per scene, in the frame's order. Labels are what the
    scene select shows and what comes back when one is picked, so two scenes
    with one name get " (2)", " (3)" to stay distinguishable."""
    options: list[tuple[str, str]] = []
    seen: dict[str, int] = {}
    for scene in frame_scenes(frame):
        base = str(scene.get("name") or scene["id"]).strip() or str(scene["id"])
        count = seen.get(base, 0) + 1
        seen[base] = count
        options.append((str(scene["id"]), base if count == 1 else f"{base} ({count})"))
    return options


def scene_label(frame: dict, scene_id: Optional[str]) -> Optional[str]:
    if not scene_id:
        return None
    for candidate_id, label in scene_options(frame):
        if candidate_id == scene_id:
            return label
    return scene_id


def scene_id_for(frame: dict, wanted: str) -> Optional[str]:
    """A scene named in a command: its label (what the select shows), its
    plain name, or its id."""
    text = str(wanted or "").strip()
    if not text:
        return None
    options = scene_options(frame)
    for scene_id, label in options:
        if label == text:
            return scene_id
    for scene_id, _label in options:
        if scene_id == text:
            return scene_id
    lowered = text.lower()
    for scene in frame_scenes(frame):
        if str(scene.get("name") or "").strip().lower() == lowered:
            return str(scene["id"])
    return None


def scene_name(frame: dict, scene_id: Optional[str]) -> Optional[str]:
    return scene_label(frame, scene_id)


def scene_public_fields(scene: dict) -> list[dict]:
    """The scene's settable fields as the runtime lists them: declared fields
    without `access: private`, plus the implicit refresh interval (the same
    rule as api/virtual_frame.py and the interpreter's publicStateFields)."""
    fields = scene.get("fields")
    settings = scene.get("settings")
    resolved = resolve_refresh_interval(
        fields if isinstance(fields, list) else [],
        settings.get("refreshInterval") if isinstance(settings, dict) else None,
    )
    return [
        field
        for field in resolved.fields
        if isinstance(field, dict) and field.get("name") and field.get("access") != "private"
    ]


def field_options(field: dict) -> list[str]:
    options: list[str] = []
    for option in field.get("options") or []:
        if isinstance(option, dict):
            value = option.get("value")
        else:
            value = option
        if value is None:
            continue
        text = str(value)
        if text not in options:
            options.append(text)
    return options


def coerce_field_value(field_spec: dict, value: Any) -> Any:
    """A value in the type the scene's field declares (a scene's state is
    typed JSON; Home Assistant templates and field defaults are text).
    Raises ValueError when it cannot be."""
    field_type = str(field_spec.get("type") or "")
    if field_type == "boolean":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("on", "true", "1", "yes"):
            return True
        if text in ("off", "false", "0", "no"):
            return False
        raise ValueError(f"{value!r} is not a boolean")
    if field_type == "integer":
        if isinstance(value, bool):
            raise ValueError(f"{value!r} is not an integer")
        number = float(value)
        if number != int(number):
            raise ValueError(f"{value!r} is not an integer")
        return int(number)
    if field_type == "float":
        if isinstance(value, bool):
            raise ValueError(f"{value!r} is not a number")
        return float(value)
    if field_type == "select":
        text = str(value)
        options = field_options(field_spec)
        if options and text not in options:
            raise ValueError(f"{text!r} is not one of {', '.join(options)}")
        return text
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def scene_attribute_fields(scene: dict) -> list[dict]:
    """The public fields the scene sensor's attributes carry."""
    return [field for field in scene_public_fields(scene) if str(field.get("type") or "") in ATTRIBUTE_FIELD_TYPES]


def scene_fields_payload(frame: dict, scene_id: Optional[str], reported: Optional[dict]) -> dict:
    """The fields topic: the showing scene and its public field values, typed
    (a reported value wins over the field's default; one that does not fit
    the type is passed as it is)."""
    scene = next((candidate for candidate in frame_scenes(frame) if str(candidate["id"]) == scene_id), None)
    values: dict[str, Any] = {}
    reported = reported if isinstance(reported, dict) else {}
    if scene is not None:
        for field in scene_attribute_fields(scene):
            name = str(field["name"])
            value = reported[name] if name in reported else field.get("value")
            if value is None:
                values[name] = None
                continue
            try:
                values[name] = coerce_field_value(field, value)
            except (TypeError, ValueError):
                values[name] = value
    return {"scene_id": scene_id if scene is not None else None, "scene": scene_label(frame, scene_id), "fields": values}


# ---- entities --------------------------------------------------------------------


def _frame_entity_configs(frame: dict) -> list[tuple[str, str, dict]]:
    """Return (component, object_id, entity-specific config) per frame entity."""
    project_id, frame_id = frame["project_id"], frame["id"]
    state_topic = frame_state_topic(project_id, frame_id)
    entities: list[tuple[str, str, dict]] = [
        (
            "image",
            "image",
            {
                "name": "Image",
                "image_topic": frame_image_topic(project_id, frame_id),
                "content_type": "image/png",
            },
        ),
        (
            "sensor",
            "status",
            {
                "name": "Status",
                "state_topic": state_topic,
                "value_template": "{{ value_json.status }}",
                "icon": "mdi:image-frame",
            },
        ),
        (
            "sensor",
            "scene",
            {
                "name": "Scene",
                "state_topic": state_topic,
                "value_template": "{{ value_json.scene or '' }}",
                # The showing scene's public field values, for templates:
                # state_attr('sensor.<frame>_scene', 'fields').city
                "json_attributes_topic": frame_fields_topic(project_id, frame_id),
                "json_attributes_template": "{{ {'scene_id': value_json.scene_id, 'fields': value_json.fields} | tojson }}",
                "icon": "mdi:movie-open-outline",
            },
        ),
        (
            "sensor",
            "last_seen",
            {
                "name": "Last seen",
                "state_topic": state_topic,
                "value_template": "{{ value_json.last_log_at or '' }}",
                "device_class": "timestamp",
                "entity_category": "diagnostic",
            },
        ),
        (
            "switch",
            "display",
            {
                "name": "Display",
                "state_topic": state_topic,
                "value_template": "{{ value_json.display or 'None' }}",
                "command_topic": frame_set_topic(project_id, frame_id, "display"),
                "payload_on": "ON",
                "payload_off": "OFF",
                "icon": "mdi:monitor",
            },
        ),
    ]
    options = scene_options(frame)
    if options:
        entities.append(
            (
                "select",
                "scene_select",
                {
                    "name": "Scene",
                    "state_topic": state_topic,
                    "value_template": "{{ value_json.scene or 'None' }}",
                    "command_topic": frame_set_topic(project_id, frame_id, "scene"),
                    "options": [label for _scene_id, label in options],
                    "icon": "mdi:movie-open-outline",
                },
            )
        )
    for object_id, name, press, icon, category in FRAME_BUTTONS:
        config: dict[str, Any] = {
            "name": name,
            "command_topic": frame_press_topic(project_id, frame_id),
            "payload_press": press,
            "icon": icon,
        }
        if category:
            config["entity_category"] = category
        if press in ("restart", "reboot"):
            config["device_class"] = "restart"
        entities.append(("button", object_id, config))
    return entities


def frame_discovery_messages(frame: dict) -> list[tuple[str, Optional[dict]]]:
    """Retained discovery configs that create/update the frame's HA device."""
    project_id, frame_id = frame["project_id"], frame["id"]
    node_id = frame_node_id(project_id, frame_id)
    device = frame_device(frame)
    messages: list[tuple[str, Optional[dict]]] = []
    for component, object_id, entity in _frame_entity_configs(frame):
        topic = f"{DISCOVERY_PREFIX}/{component}/{node_id}/{object_id}/config"
        payload = {
            "unique_id": f"{node_id}_{object_id}",
            "availability_topic": AVAILABILITY_TOPIC,
            "device": device,
            **entity,
        }
        messages.append((topic, payload))
    return messages


def frame_removal_messages(project_id: int, frame_id: int) -> list[tuple[str, Optional[dict]]]:
    """Empty retained payloads that make HA drop the frame's device."""
    node_id = frame_node_id(project_id, frame_id)
    # A scene so the select is among the entities.
    fixed = {"project_id": project_id, "id": frame_id, "scenes": [{"id": "-", "name": "-"}]}
    return [
        (f"{DISCOVERY_PREFIX}/{component}/{node_id}/{object_id}/config", None)
        for component, object_id, _entity in _frame_entity_configs(fixed)
    ]


def frame_state_payload(
    frame: dict,
    active_scene_id: Optional[str] = None,
    display: Optional[str] = None,
) -> dict:
    """`display` is "on" / "off" as the frame last reported it, None unknown."""
    return {
        "name": frame.get("name"),
        "status": frame.get("status"),
        "scene": scene_label(frame, active_scene_id),
        "scene_id": active_scene_id,
        "display": {"on": "ON", "off": "OFF"}.get(str(display or "").lower()),
        "last_log_at": frame.get("last_log_at"),
    }


def summary_discovery_message(project_id: int) -> tuple[str, dict]:
    node_id = hub_node_id(project_id)
    topic = f"{DISCOVERY_PREFIX}/sensor/{node_id}/frames/config"
    state_topic = summary_state_topic(project_id)
    payload = {
        "unique_id": f"{node_id}_frames",
        "name": "Frames",
        "state_topic": state_topic,
        "value_template": "{{ value_json.count }}",
        "json_attributes_topic": state_topic,
        "json_attributes_template": "{{ {'frames': value_json.frames} | tojson }}",
        "icon": "mdi:image-multiple-outline",
        "availability_topic": AVAILABILITY_TOPIC,
        "device": hub_device(project_id),
    }
    return topic, payload


def summary_state_payload(frames: list[dict]) -> dict:
    """State for the frame-count sensor; pass only non-archived frames."""
    return {
        "count": len(frames),
        "frames": [frame.get("name") or f"Frame {frame['id']}" for frame in frames],
    }


def ha_event_payload(frame_id: int, project_id: int, frame_name: Optional[str], event: str, log: dict) -> dict:
    payload = {key: value for key, value in log.items() if key != "event"}
    return {
        "frame_id": frame_id,
        "project_id": project_id,
        "frame_name": frame_name,
        "event": event,
        "payload": payload,
    }
