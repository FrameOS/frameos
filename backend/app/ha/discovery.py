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
  previous scene, restart and reboot;
- one entity per public field of every scene on the frame (a `switch`,
  `number`, `select` or `text` by the field's type): the scene's
  parameters, settable from Home Assistant.

Every command entity publishes to a topic under the frame's base topic;
`frame_command_subscriptions()` lists the filters the sync subscribes to.
"""

import hashlib
import json
import re
from typing import Any, Iterable, Optional

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

# Field type → Home Assistant component. Everything else (json, image, font,
# node, scene, path) has no sensible Home Assistant control and is skipped.
FIELD_COMPONENTS: dict[str, str] = {
    "boolean": "switch",
    "integer": "number",
    "float": "number",
    "select": "select",
    "string": "text",
    "text": "text",
    "color": "text",
    "date": "text",
}
# MQTT number needs bounds; a scene field declares none, so these are wide.
NUMBER_MIN = -1000000000
NUMBER_MAX = 1000000000
TEXT_MAX = 255


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
    """Retained JSON {scene id: {field name: value as text}} for every scene's
    public fields: the state of the field entities."""
    return f"{frame_base_topic(project_id, frame_id)}/fields"


def frame_command_topic(project_id: int, frame_id: int) -> str:
    """Free-form commands from automations: {"event": name, "payload": {...}}
    or {"scene": name or id, "state": {...}} (docs/home-assistant.md)."""
    return f"{frame_base_topic(project_id, frame_id)}/command"


def frame_press_topic(project_id: int, frame_id: int) -> str:
    return f"{frame_base_topic(project_id, frame_id)}/press"


def frame_set_topic(project_id: int, frame_id: int, what: str) -> str:
    """`scene` (the select), `display` (the switch), `field` (every field entity)."""
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


def field_component(field: dict) -> Optional[str]:
    return FIELD_COMPONENTS.get(str(field.get("type") or ""))


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


def field_state_text(field: dict, value: Any) -> str:
    """One field value the way the entity's state topic carries it."""
    if value is None:
        return ""
    field_type = str(field.get("type") or "")
    if field_type == "boolean":
        if isinstance(value, str):
            return "true" if value.strip().lower() in ("true", "1", "yes", "on") else "false"
        return "true" if value else "false"
    if field_type in ("integer", "float"):
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float)):
            return str(value)
        return str(value).strip()
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def _slug(text: str, limit: int = 40) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(text)).strip("_")
    return cleaned[:limit] or "x"


def _short_hash(text: str) -> str:
    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()[:8]


def field_object_id(scene_id: str, field_name: str) -> str:
    """Discovery object ids allow [a-zA-Z0-9_-] only; the hash keeps two
    fields distinct when their names differ only in other characters."""
    return f"field_{_short_hash(scene_id)}_{_slug(field_name)}_{_short_hash(field_name)[:4]}"


def _jinja_string(text: str) -> str:
    # A JSON string literal is a valid Jinja string literal for everything a
    # scene id or field name holds.
    return json.dumps(str(text))


def _field_value_template(scene_id: str, field_name: str, missing: str) -> str:
    return (
        "{{ value_json.get(" + _jinja_string(scene_id) + ", {}).get("
        + _jinja_string(field_name) + ", " + _jinja_string(missing) + ") }}"
    )


def _field_command(scene_id: str, field_name: str, value_expression: str) -> str:
    return (
        '{"scene": ' + json.dumps(scene_id) + ', "field": ' + json.dumps(field_name)
        + ', "value": ' + value_expression + "}"
    )


def scene_field_entities(frame: dict) -> list[tuple[str, str, dict]]:
    """(component, object_id, config) per public field of every scene."""
    project_id, frame_id = frame["project_id"], frame["id"]
    fields_topic = frame_fields_topic(project_id, frame_id)
    command_topic = frame_set_topic(project_id, frame_id, "field")
    entities: list[tuple[str, str, dict]] = []
    for scene_id, label in scene_options(frame):
        scene = next(scene for scene in frame_scenes(frame) if str(scene["id"]) == scene_id)
        for field in scene_public_fields(scene):
            component = field_component(field)
            if component is None:
                continue
            name = str(field["name"])
            config: dict[str, Any] = {
                "name": f"{label}: {field.get('label') or name}",
                "state_topic": fields_topic,
                "icon": "mdi:tune-variant",
            }
            if component == "switch":
                config.update(
                    {
                        "command_topic": command_topic,
                        "payload_on": _field_command(scene_id, name, '"true"'),
                        "payload_off": _field_command(scene_id, name, '"false"'),
                        "state_on": "true",
                        "state_off": "false",
                        "value_template": _field_value_template(scene_id, name, ""),
                    }
                )
            elif component == "number":
                is_float = field.get("type") == "float"
                config.update(
                    {
                        "command_topic": command_topic,
                        "command_template": _field_command(scene_id, name, "{{ value }}"),
                        "value_template": _field_value_template(scene_id, name, "None"),
                        "min": 0 if field.get("role") == "refreshInterval" else NUMBER_MIN,
                        "max": NUMBER_MAX,
                        "step": 0.01 if is_float else 1,
                        "mode": "box",
                    }
                )
                if field.get("role") == "refreshInterval":
                    config["unit_of_measurement"] = "s"
                    config["icon"] = "mdi:timer-outline"
            elif component == "select":
                options = field_options(field)
                if not options:
                    continue
                config.update(
                    {
                        "command_topic": command_topic,
                        "command_template": _field_command(scene_id, name, "{{ value | tojson }}"),
                        "value_template": _field_value_template(scene_id, name, "None"),
                        "options": options,
                    }
                )
            else:  # text
                config.update(
                    {
                        "command_topic": command_topic,
                        "command_template": _field_command(scene_id, name, "{{ value | tojson }}"),
                        "value_template": _field_value_template(scene_id, name, ""),
                        "max": TEXT_MAX,
                    }
                )
                if field.get("type") == "color":
                    config["icon"] = "mdi:palette"
            entities.append((component, field_object_id(scene_id, name), config))
    return entities


def fields_state_payload(
    frame: dict,
    states: dict[str, dict],
    pending: Optional[dict[str, dict]] = None,
) -> dict[str, dict[str, str]]:
    """The fields topic: every public field of every scene, as text. A value
    the frame reported wins, then one Home Assistant set while the scene was
    not showing (kept for its next activation), then the field's default."""
    payload: dict[str, dict[str, str]] = {}
    for scene in frame_scenes(frame):
        scene_id = str(scene["id"])
        reported_candidate = states.get(scene_id)
        reported: dict = reported_candidate if isinstance(reported_candidate, dict) else {}
        waiting_candidate = (pending or {}).get(scene_id)
        waiting: dict = waiting_candidate if isinstance(waiting_candidate, dict) else {}
        values: dict[str, str] = {}
        for field in scene_public_fields(scene):
            if field_component(field) is None:
                continue
            name = str(field["name"])
            if name in waiting:
                value = waiting[name]
            elif name in reported:
                value = reported[name]
            else:
                value = field.get("value")
            values[name] = field_state_text(field, value)
        payload[scene_id] = values
    return payload


# ---- entities --------------------------------------------------------------------


def _frame_entity_configs(frame: dict, include_fields: bool = True) -> list[tuple[str, str, dict]]:
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
    if include_fields:
        entities.extend(scene_field_entities(frame))
    return entities


def entity_key(component: str, object_id: str) -> str:
    return f"{component}/{object_id}"


def frame_entity_keys(frame: dict, include_fields: bool = True) -> set[str]:
    return {entity_key(component, object_id) for component, object_id, _ in _frame_entity_configs(frame, include_fields)}


def frame_discovery_messages(frame: dict, include_fields: bool = True) -> list[tuple[str, Optional[dict]]]:
    """Retained discovery configs that create/update the frame's HA device."""
    project_id, frame_id = frame["project_id"], frame["id"]
    node_id = frame_node_id(project_id, frame_id)
    device = frame_device(frame)
    messages: list[tuple[str, Optional[dict]]] = []
    for component, object_id, entity in _frame_entity_configs(frame, include_fields):
        topic = f"{DISCOVERY_PREFIX}/{component}/{node_id}/{object_id}/config"
        payload = {
            "unique_id": f"{node_id}_{object_id}",
            "availability_topic": AVAILABILITY_TOPIC,
            "device": device,
            **entity,
        }
        messages.append((topic, payload))
    return messages


def entity_removal_messages(project_id: int, frame_id: int, keys: Iterable[str]) -> list[tuple[str, Optional[dict]]]:
    """Empty retained payloads for the given component/object_id keys."""
    node_id = frame_node_id(project_id, frame_id)
    messages: list[tuple[str, Optional[dict]]] = []
    for key in sorted(set(keys)):
        component, _, object_id = key.partition("/")
        if component and object_id:
            messages.append((f"{DISCOVERY_PREFIX}/{component}/{node_id}/{object_id}/config", None))
    return messages


def frame_removal_messages(
    project_id: int, frame_id: int, extra_keys: Iterable[str] = ()
) -> list[tuple[str, Optional[dict]]]:
    """Empty retained payloads that make HA drop the frame's device: the fixed
    entities, plus any keys the sync recorded for this frame (its field
    entities, whose names depend on the scenes it had)."""
    # A scene so the select is among the fixed entities; no fields.
    fixed = {"project_id": project_id, "id": frame_id, "scenes": [{"id": "-", "name": "-"}]}
    keys = frame_entity_keys(fixed, include_fields=False) | set(extra_keys)
    return entity_removal_messages(project_id, frame_id, keys)


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
