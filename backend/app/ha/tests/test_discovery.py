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


def test_frame_discovery_messages_cover_all_entities():
    messages = discovery.frame_discovery_messages(make_frame())
    topics = [topic for topic, _payload in messages]
    assert topics == [
        "homeassistant/image/frameos_3_7/image/config",
        "homeassistant/sensor/frameos_3_7/status/config",
        "homeassistant/sensor/frameos_3_7/scene/config",
        "homeassistant/sensor/frameos_3_7/last_seen/config",
    ]
    for _topic, payload in messages:
        assert payload["availability_topic"] == discovery.AVAILABILITY_TOPIC
        assert payload["device"]["identifiers"] == ["frameos_frame_3_7"]
        assert payload["device"]["name"] == "Kitchen frame"
        assert payload["device"]["sw_version"] == "2026.7.2"
        assert payload["device"]["via_device"] == "frameos_3"
        assert payload["unique_id"].startswith("frameos_3_7_")

    image_payload = messages[0][1]
    assert image_payload["image_topic"] == "frameos/frame/3/7/image"
    assert image_payload["content_type"] == "image/png"

    status_payload = messages[1][1]
    assert status_payload["state_topic"] == "frameos/frame/3/7/state"
    assert status_payload["value_template"] == "{{ value_json.status }}"


def test_frame_removal_messages_clear_every_discovery_topic():
    discovery_topics = {topic for topic, _ in discovery.frame_discovery_messages(make_frame())}
    removal = discovery.frame_removal_messages(3, 7)
    assert {topic for topic, _ in removal} == discovery_topics
    assert all(payload is None for _topic, payload in removal)


def test_frame_state_payload_resolves_scene_name():
    frame = make_frame()
    payload = discovery.frame_state_payload(frame, "scene-2")
    assert payload == {
        "name": "Kitchen frame",
        "status": "ready",
        "scene": "Weather",
        "last_log_at": "2026-07-08T10:00:00+00:00",
    }
    # Unknown scene ids fall back to the raw id, missing ones to None
    assert discovery.frame_state_payload(frame, "mystery")["scene"] == "mystery"
    assert discovery.frame_state_payload(frame, None)["scene"] is None


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
