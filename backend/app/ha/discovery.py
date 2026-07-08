"""
Topic and payload builders for the Home Assistant integration.

Pure functions only: everything here maps FrameOS state (frame dicts as
produced by Frame.to_dict()) to MQTT discovery topics and JSON payloads,
so it can be tested without a broker. Publishing lives in app.ha.sync.
"""

from typing import Any, Optional

DISCOVERY_PREFIX = "homeassistant"
AVAILABILITY_TOPIC = "frameos/status"
HA_EVENT_TYPE = "frameos_event"

# Frame log events that are noise for Home Assistant automations. Everything
# else (render lifecycle, bootup, buttons, custom scene events, ...) is
# forwarded to the HA event bus and the frame's MQTT event topic.
SKIPPED_LOG_EVENTS = {"log", "debug", "metrics"}


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


def _frame_entity_configs(frame: dict) -> list[tuple[str, str, dict]]:
    """Return (component, object_id, entity-specific config) per frame entity."""
    project_id, frame_id = frame["project_id"], frame["id"]
    state_topic = frame_state_topic(project_id, frame_id)
    return [
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
    ]


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
    fake_frame = {"project_id": project_id, "id": frame_id}
    return [
        (f"{DISCOVERY_PREFIX}/{component}/{node_id}/{object_id}/config", None)
        for component, object_id, _entity in _frame_entity_configs(fake_frame)
    ]


def scene_name(frame: dict, scene_id: Optional[str]) -> Optional[str]:
    if not scene_id:
        return None
    for scene in frame.get("scenes") or []:
        if isinstance(scene, dict) and scene.get("id") == scene_id:
            return scene.get("name") or scene_id
    return scene_id


def frame_state_payload(frame: dict, active_scene_id: Optional[str] = None) -> dict:
    return {
        "name": frame.get("name"),
        "status": frame.get("status"),
        "scene": scene_name(frame, active_scene_id),
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
