import json

from app.ha import discovery


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
    # The fixed entities of every frame, then the scenes' field entities
    # (none here: the scenes declare no fields beyond the implicit interval).
    assert topics[:11] == [
        "homeassistant/image/frameos_3_7/image/config",
        "homeassistant/sensor/frameos_3_7/status/config",
        "homeassistant/sensor/frameos_3_7/scene/config",
        "homeassistant/sensor/frameos_3_7/last_seen/config",
        "homeassistant/switch/frameos_3_7/display/config",
        "homeassistant/select/frameos_3_7/scene_select/config",
        "homeassistant/button/frameos_3_7/refresh/config",
        "homeassistant/button/frameos_3_7/next_scene/config",
        "homeassistant/button/frameos_3_7/previous_scene/config",
        "homeassistant/button/frameos_3_7/restart/config",
        "homeassistant/button/frameos_3_7/reboot/config",
    ]
    assert [topic.split("/")[1] for topic in topics[11:]] == ["number", "number"]  # the two refresh intervals
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
    assert by_topic["homeassistant/button/frameos_3_7/refresh/config"]["payload_press"] == "render"
    assert "entity_category" not in by_topic["homeassistant/button/frameos_3_7/next_scene/config"]

    # The fixed entities alone when the project keeps scene fields off.
    assert len(discovery.frame_discovery_messages(make_frame(), include_fields=False)) == 11
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


def test_scene_field_entities_follow_the_field_types():
    frame = make_frame(scenes=[weather_scene()])
    entities = {object_id: (component, config) for component, object_id, config in discovery.scene_field_entities(frame)}
    by_name = {config["name"]: (component, config) for component, config in entities.values()}
    # Private, json and image fields have no entity; the implicit interval does.
    assert sorted(by_name) == [
        "Weather: City",
        "Weather: Dark mode",
        "Weather: Refresh interval (seconds)",
        "Weather: days",
        "Weather: scale",
        "Weather: units",
    ]
    component, city = by_name["Weather: City"]
    assert component == "text"
    assert city["command_topic"] == "frameos/frame/3/7/set/field"
    assert city["state_topic"] == "frameos/frame/3/7/fields"
    assert city["command_template"] == '{"scene": "scene-2", "field": "city", "value": {{ value | tojson }}}'
    assert city["value_template"] == '{{ value_json.get("scene-2", {}).get("city", "") }}'

    component, dark = by_name["Weather: Dark mode"]
    assert component == "switch"
    assert json.loads(dark["payload_on"]) == {"scene": "scene-2", "field": "dark", "value": "true"}
    assert json.loads(dark["payload_off"]) == {"scene": "scene-2", "field": "dark", "value": "false"}
    assert (dark["state_on"], dark["state_off"]) == ("true", "false")

    component, units = by_name["Weather: units"]
    assert component == "select"
    assert units["options"] == ["metric", "imperial"]

    component, days = by_name["Weather: days"]
    assert (component, days["step"], days["mode"]) == ("number", 1, "box")
    assert by_name["Weather: scale"][1]["step"] == 0.01
    interval = by_name["Weather: Refresh interval (seconds)"][1]
    assert (interval["min"], interval["unit_of_measurement"]) == (0, "s")

    # Object ids are discovery-safe and stable.
    expected_ids = {discovery.field_object_id("scene-2", name) for name in ("city", "units", "dark", "days", "scale", "refreshInterval")}
    assert set(entities) == expected_ids
    assert discovery.field_object_id("scene-2", "city") != discovery.field_object_id("scene-2", "city!")
    assert all(ch.isalnum() or ch in "_-" for ch in discovery.field_object_id("ä scene/1", "my field?"))


def test_fields_state_payload_prefers_reported_then_pending_then_default():
    frame = make_frame(scenes=[weather_scene(), {"id": "scene-1", "name": "Clock"}])
    payload = discovery.fields_state_payload(
        frame,
        states={"scene-2": {"city": "Rome", "days": 5, "dark": True, "apiKey": "secret"}},
        pending={"scene-2": {"city": "Oslo"}, "scene-1": {"refreshInterval": 42}},
    )
    assert payload["scene-2"] == {
        "city": "Oslo",  # Home Assistant's value waiting for the scene wins the display
        "units": "metric",
        "dark": "true",
        "days": "5",
        "scale": "1.5",
        "refreshInterval": "600",
    }
    assert payload["scene-1"] == {"refreshInterval": "42"}
    assert discovery.field_state_text({"type": "boolean"}, "yes") == "true"
    assert discovery.field_state_text({"type": "integer"}, 3.0) == "3.0"
    assert discovery.field_state_text({"type": "string"}, None) == ""


def test_frame_removal_messages_clear_every_discovery_topic():
    discovery_topics = {topic for topic, _ in discovery.frame_discovery_messages(make_frame(), include_fields=False)}
    removal = discovery.frame_removal_messages(3, 7)
    assert {topic for topic, _ in removal} == discovery_topics
    assert all(payload is None for _topic, payload in removal)
    # Field entities depend on the scenes the frame had: the sync passes the
    # keys it recorded, and they are retracted by name.
    with_fields = discovery.frame_removal_messages(3, 7, ["text/field_abc_city_1234", "number/field_abc_days_9999"])
    assert "homeassistant/text/frameos_3_7/field_abc_city_1234/config" in {topic for topic, _ in with_fields}
    assert len(with_fields) == len(removal) + 2
    assert discovery.entity_removal_messages(3, 7, ["bogus"]) == []


def test_frame_entity_keys_match_discovery():
    frame = make_frame(scenes=[weather_scene()])
    keys = discovery.frame_entity_keys(frame)
    topics = {topic for topic, _ in discovery.frame_discovery_messages(frame)}
    assert {f"homeassistant/{key.split('/')[0]}/frameos_3_7/{key.split('/')[1]}/config" for key in keys} == topics


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
        "frameos/frame/3/7/set/field",
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
