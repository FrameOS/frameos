import json

import pytest

from app.ha import discovery
from app.ha.discovery import fit_image


def make_frame(**overrides) -> dict:
    frame = {
        "id": 7,
        "project_id": 3,
        "name": "Kitchen frame",
        "device": "pimoroni.inky_impression_13",
        "version": "2026.7.2",
        "status": "ready",
        "archived": False,
        "last_log_at": "2026-07-08T10:00:00+00:00",
        "scenes": [
            {"id": "scene-1", "name": "Clock"},
            {"id": "scene-2", "name": "Weather"},
        ],
    }
    frame.update(overrides)
    return frame


def weather_scene() -> dict:
    return {
        "id": "scene-2",
        "name": "Weather",
        "settings": {"refreshInterval": 600},
        "fields": [
            {"name": "city", "label": "City", "type": "string", "value": "Brussels", "access": "public"},
            {"name": "units", "type": "select", "options": ["metric", {"value": "imperial", "label": "°F"}], "value": "metric"},
            {"name": "dark", "label": "Dark mode", "type": "boolean", "value": "false", "access": "public"},
            {"name": "days", "type": "integer", "value": "3", "access": "public"},
            {"name": "scale", "type": "float", "value": "1.5", "access": "public"},
            {"name": "apiKey", "type": "string", "value": "", "access": "private"},
            {"name": "layout", "type": "json", "value": "{}", "access": "public"},
            {"name": "photo", "type": "image", "value": "", "access": "public"},
        ],
    }


def test_frame_discovery_messages_cover_all_entities():
    messages = discovery.frame_discovery_messages(make_frame())
    topics = [topic for topic, _payload in messages]
    # The same twelve entities for every frame, whatever its scenes hold:
    # the scenes' fields are the scene sensor's attributes, not entities.
    assert topics == [
        "homeassistant/image/frameos_3_7/image/config",
        "homeassistant/sensor/frameos_3_7/status/config",
        "homeassistant/sensor/frameos_3_7/scene/config",
        "homeassistant/sensor/frameos_3_7/last_seen/config",
        "homeassistant/switch/frameos_3_7/display/config",
        "homeassistant/select/frameos_3_7/scene_select/config",
        "homeassistant/button/frameos_3_7/refresh/config",
        "homeassistant/button/frameos_3_7/render/config",
        "homeassistant/button/frameos_3_7/next_scene/config",
        "homeassistant/button/frameos_3_7/previous_scene/config",
        "homeassistant/button/frameos_3_7/restart/config",
        "homeassistant/button/frameos_3_7/reboot/config",
    ]
    assert len(discovery.frame_discovery_messages(make_frame(scenes=[weather_scene()]))) == 12
    for _topic, payload in messages:
        assert payload["availability_topic"] == discovery.AVAILABILITY_TOPIC
        assert payload["device"]["identifiers"] == ["frameos_frame_3_7"]
        assert payload["device"]["name"] == "Kitchen frame"
        assert payload["device"]["sw_version"] == "2026.7.2"
        assert payload["device"]["via_device"] == "frameos_3"
        assert payload["unique_id"].startswith("frameos_3_7_")

    by_topic = dict(messages)
    image_payload = by_topic["homeassistant/image/frameos_3_7/image/config"]
    assert image_payload["image_topic"] == "frameos/frame/3/7/image"
    assert image_payload["content_type"] == "image/png"

    status_payload = by_topic["homeassistant/sensor/frameos_3_7/status/config"]
    assert status_payload["state_topic"] == "frameos/frame/3/7/state"
    assert status_payload["value_template"] == "{{ value_json.status }}"

    scene_sensor = by_topic["homeassistant/sensor/frameos_3_7/scene/config"]
    assert scene_sensor["json_attributes_topic"] == "frameos/frame/3/7/fields"
    assert "value_json.fields" in scene_sensor["json_attributes_template"]

    select = by_topic["homeassistant/select/frameos_3_7/scene_select/config"]
    assert select["options"] == ["Clock", "Weather"]
    assert select["command_topic"] == "frameos/frame/3/7/set/scene"
    assert select["state_topic"] == "frameos/frame/3/7/state"

    display = by_topic["homeassistant/switch/frameos_3_7/display/config"]
    assert display["command_topic"] == "frameos/frame/3/7/set/display"
    assert (display["payload_on"], display["payload_off"]) == ("ON", "OFF")

    reboot = by_topic["homeassistant/button/frameos_3_7/reboot/config"]
    assert reboot["command_topic"] == "frameos/frame/3/7/press"
    assert reboot["payload_press"] == "reboot"
    assert reboot["entity_category"] == "config"
    # Refresh image asks the backend for the panel; Re-render asks the frame
    # for a render. One button for both advanced a random-photo scene (#661).
    refresh = by_topic["homeassistant/button/frameos_3_7/refresh/config"]
    assert (refresh["name"], refresh["payload_press"]) == ("Refresh image", "refresh_image")
    render = by_topic["homeassistant/button/frameos_3_7/render/config"]
    assert (render["name"], render["payload_press"]) == ("Re-render", "render")
    assert "entity_category" not in by_topic["homeassistant/button/frameos_3_7/next_scene/config"]

    # No scenes: no select (an empty option list is not an entity).
    bare = [topic for topic, _ in discovery.frame_discovery_messages(make_frame(scenes=[]))]
    assert "homeassistant/select/frameos_3_7/scene_select/config" not in bare


def test_scene_options_keep_duplicate_names_apart():
    frame = make_frame(scenes=[{"id": "a", "name": "Clock"}, {"id": "b", "name": "Clock"}, {"id": "c"}])
    assert discovery.scene_options(frame) == [("a", "Clock"), ("b", "Clock (2)"), ("c", "c")]
    assert discovery.scene_label(frame, "b") == "Clock (2)"
    # A command may say the label, the id, or the plain name (first match).
    assert discovery.scene_id_for(frame, "Clock (2)") == "b"
    assert discovery.scene_id_for(frame, "b") == "b"
    assert discovery.scene_id_for(frame, "clock") == "a"
    assert discovery.scene_id_for(frame, "Nope") is None


def test_scene_fields_payload_is_the_showing_scenes_public_fields_typed():
    frame = make_frame(scenes=[weather_scene(), {"id": "scene-1", "name": "Clock"}])
    payload = discovery.scene_fields_payload(
        frame, "scene-2", {"city": "Rome", "days": "5", "dark": True, "apiKey": "secret", "layout": "{}"}
    )
    # Private, json and image fields stay out; defaults are typed too; the
    # implicit refresh interval is a field like any other.
    assert payload == {
        "scene_id": "scene-2",
        "scene": "Weather",
        "fields": {
            "city": "Rome",
            "units": "metric",
            "dark": True,
            "days": 5,
            "scale": 1.5,
            "refreshInterval": 600,
        },
    }
    # A value that does not fit its type is passed as it is, not dropped.
    assert discovery.scene_fields_payload(frame, "scene-2", {"days": "many"})["fields"]["days"] == "many"
    assert discovery.scene_fields_payload(frame, "scene-1", None) == {
        "scene_id": "scene-1",
        "scene": "Clock",
        "fields": {"refreshInterval": 300},
    }
    assert discovery.scene_fields_payload(frame, "gone", None) == {"scene_id": None, "scene": "gone", "fields": {}}
    assert discovery.scene_fields_payload(frame, None, None) == {"scene_id": None, "scene": None, "fields": {}}
    # The payload is JSON; attributes carry it as Home Assistant got it.
    assert json.loads(json.dumps(payload)) == payload


@pytest.mark.parametrize(
    "spec, value, expected",
    [
        ({"type": "boolean"}, "ON", True),
        ({"type": "boolean"}, 0, False),
        ({"type": "integer"}, "7", 7),
        ({"type": "integer"}, 4.0, 4),
        ({"type": "float"}, "0.5", 0.5),
        ({"type": "string"}, 12, "12"),
        ({"type": "color"}, "#fff", "#fff"),
        ({"type": "string"}, {"a": 1}, '{"a": 1}'),
        ({"type": "select", "options": ["a", {"value": "b", "label": "B"}]}, "b", "b"),
        ({"type": "select", "options": []}, "anything", "anything"),
    ],
)
def test_coerce_field_value(spec, value, expected):
    assert discovery.coerce_field_value(spec, value) == expected


@pytest.mark.parametrize(
    "spec, value",
    [
        ({"type": "boolean"}, "maybe"),
        ({"type": "integer"}, "1.5"),
        ({"type": "integer"}, True),
        ({"type": "float"}, "x"),
        ({"type": "select", "options": ["a"]}, "b"),
    ],
)
def test_coerce_field_value_refuses_the_wrong_shape(spec, value):
    with pytest.raises(ValueError):
        discovery.coerce_field_value(spec, value)


def test_frame_removal_messages_clear_every_discovery_topic():
    discovery_topics = {topic for topic, _ in discovery.frame_discovery_messages(make_frame(scenes=[weather_scene()]))}
    removal = discovery.frame_removal_messages(3, 7)
    assert {topic for topic, _ in removal} == discovery_topics
    assert all(payload is None for _topic, payload in removal)


def test_frame_state_payload_resolves_scene_name():
    frame = make_frame()
    payload = discovery.frame_state_payload(frame, "scene-2", display="on")
    assert payload == {
        "name": "Kitchen frame",
        "status": "ready",
        "scene": "Weather",
        "scene_id": "scene-2",
        "display": "ON",
        "last_log_at": "2026-07-08T10:00:00+00:00",
    }
    # Unknown scene ids fall back to the raw id, missing ones to None
    assert discovery.frame_state_payload(frame, "mystery")["scene"] == "mystery"
    assert discovery.frame_state_payload(frame, None)["scene"] is None
    assert discovery.frame_state_payload(frame, None, display="off")["display"] == "OFF"
    assert discovery.frame_state_payload(frame, None)["display"] is None


def test_command_subscriptions_cover_every_command_topic():
    frame = make_frame(scenes=[weather_scene()])
    command_topics = {
        payload["command_topic"] for _topic, payload in discovery.frame_discovery_messages(frame) if "command_topic" in payload
    }
    command_topics.add(discovery.frame_command_topic(3, 7))
    filters = discovery.frame_command_subscriptions()

    def matches(topic: str) -> bool:
        for pattern in filters:
            parts, wanted = pattern.split("/"), topic.split("/")
            if len(parts) == len(wanted) and all(p == "+" or p == w for p, w in zip(parts, wanted)):
                return True
        return False

    assert command_topics == {
        "frameos/frame/3/7/set/scene",
        "frameos/frame/3/7/set/display",
        "frameos/frame/3/7/press",
        "frameos/frame/3/7/command",
    }
    assert all(matches(topic) for topic in command_topics)


def test_summary_messages():
    topic, payload = discovery.summary_discovery_message(3)
    assert topic == "homeassistant/sensor/frameos_3/frames/config"
    assert payload["state_topic"] == "frameos/frames/3/state"
    assert payload["device"]["identifiers"] == ["frameos_3"]

    state = discovery.summary_state_payload([make_frame(), make_frame(id=8, name=None)])
    assert state == {"count": 2, "frames": ["Kitchen frame", "Frame 8"]}


def test_ha_event_payload_strips_event_key():
    payload = discovery.ha_event_payload(7, 3, "Kitchen frame", "button_press", {"event": "button_press", "button": "a"})
    assert payload == {
        "frame_id": 7,
        "project_id": 3,
        "frame_name": "Kitchen frame",
        "event": "button_press",
        "payload": {"button": "a"},
    }


def _png(width: int, height: int, noisy: bool) -> bytes:
    import io
    import os

    from PIL import Image

    if noisy:
        image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    else:
        image = Image.new("RGB", (width, height), (200, 30, 30))
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def test_fit_image_leaves_a_small_render_alone():
    small = _png(800, 480, noisy=False)
    assert fit_image(small) is small
    assert fit_image(b"not an image") == b"not an image"


def test_fit_image_downscales_a_large_render_to_the_packet_budget():
    import io

    from PIL import Image

    # A photo frame's 1920x1080 render (noise: as incompressible as a photo
    # gets) is several MB; the image topic gets a PNG under the budget, at
    # most IMAGE_MAX_EDGE on its longest edge, in the render's aspect ratio.
    large = _png(1920, 1080, noisy=True)
    assert len(large) > discovery.IMAGE_MAX_BYTES
    fitted = fit_image(large)
    assert len(fitted) <= discovery.IMAGE_MAX_BYTES
    with Image.open(io.BytesIO(fitted)) as image:
        assert image.format == "PNG"
        assert max(image.size) <= discovery.IMAGE_MAX_EDGE
        assert max(image.size) in discovery.IMAGE_EDGES
        assert abs(image.size[0] / image.size[1] - 16 / 9) < 0.01

    # A large but plain render only needs the edge cap.
    plain = _png(1600, 1200, noisy=False)
    with Image.open(io.BytesIO(fit_image(plain))) as image:
        assert image.size == (1280, 960)
