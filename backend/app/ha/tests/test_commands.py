import json

import pytest

from app.ha import commands
from app.ha.commands import Topic, parse_topic, resolve_command
from app.ha.tests.test_discovery import make_frame, weather_scene


def frame_with_fields() -> dict:
    return make_frame(scenes=[{"id": "scene-1", "name": "Clock"}, weather_scene(), {"id": "scene-3", "name": "Photos"}])


def test_parse_topic_reads_the_frame_and_the_kind():
    assert parse_topic("frameos/frame/3/7/press") == Topic(3, 7, "press")
    assert parse_topic("frameos/frame/3/7/command") == Topic(3, 7, "command")
    assert parse_topic("frameos/frame/3/7/set/scene") == Topic(3, 7, "set", "scene")
    assert parse_topic("frameos/frame/3/7/set/field") == Topic(3, 7, "set", "field")
    for bad in ("frameos/frame/3/7/state", "frameos/frame/x/7/press", "homeassistant/switch/a/b/config", "", "frameos/frame/3/7/set"):
        assert parse_topic(bad) is None


def test_buttons():
    frame = frame_with_fields()
    render = resolve_command(Topic(3, 7, "press"), b"render", frame, "scene-2")
    assert (render.kind, render.event, render.payload) == ("event", "render", {})

    following = resolve_command(Topic(3, 7, "press"), "next_scene", frame, "scene-2")
    assert (following.event, following.payload) == ("setCurrentScene", {"sceneId": "scene-3"})
    wrapped = resolve_command(Topic(3, 7, "press"), "next_scene", frame, "scene-3")
    assert wrapped.payload == {"sceneId": "scene-1"}
    previous = resolve_command(Topic(3, 7, "press"), "previous_scene", frame, "scene-1")
    assert previous.payload == {"sceneId": "scene-3"}
    # No known scene: the first one.
    assert resolve_command(Topic(3, 7, "press"), "next_scene", frame, None).payload == {"sceneId": "scene-1"}
    assert resolve_command(Topic(3, 7, "press"), "next_scene", make_frame(scenes=[]), None).kind == "error"

    assert resolve_command(Topic(3, 7, "press"), "restart", frame, None).kind == "restart"
    assert resolve_command(Topic(3, 7, "press"), "reboot", frame, None).kind == "reboot"
    assert resolve_command(Topic(3, 7, "press"), "explode", frame, None).kind == "error"


def test_display_switch():
    frame = frame_with_fields()
    assert resolve_command(Topic(3, 7, "set", "display"), b"ON", frame, None).event == "turnOn"
    assert resolve_command(Topic(3, 7, "set", "display"), "off", frame, None).event == "turnOff"
    assert resolve_command(Topic(3, 7, "set", "display"), "dim", frame, None).kind == "error"


def test_scene_select_carries_the_values_kept_for_that_scene():
    frame = frame_with_fields()
    plain = resolve_command(Topic(3, 7, "set", "scene"), "Weather", frame, "scene-1")
    assert (plain.event, plain.payload, plain.consumes_pending) == ("setCurrentScene", {"sceneId": "scene-2"}, None)

    pending = {"scene-2": {"city": "Oslo", "days": 5}}
    kept = resolve_command(Topic(3, 7, "set", "scene"), "Weather", frame, "scene-1", pending)
    assert kept.payload == {"sceneId": "scene-2", "state": {"city": "Oslo", "days": 5}}
    assert kept.consumes_pending == "scene-2"
    # By id works too; an unknown scene is refused.
    assert resolve_command(Topic(3, 7, "set", "scene"), "scene-3", frame, None).payload == {"sceneId": "scene-3"}
    assert resolve_command(Topic(3, 7, "set", "scene"), "Nope", frame, None).kind == "error"


def test_field_of_the_showing_scene_is_set_at_once_and_typed():
    frame = frame_with_fields()

    def set_field(name, value, active="scene-2"):
        return resolve_command(
            Topic(3, 7, "set", "field"), json.dumps({"scene": "scene-2", "field": name, "value": value}), frame, active
        )

    city = set_field("city", "Rome")
    assert (city.kind, city.event, city.payload) == ("event", "setSceneState", {"state": {"city": "Rome"}})
    assert set_field("dark", "true").payload == {"state": {"dark": True}}
    assert set_field("dark", "false").payload == {"state": {"dark": False}}
    assert set_field("days", 4).payload == {"state": {"days": 4}}
    assert set_field("days", "4.0").payload == {"state": {"days": 4}}
    assert set_field("scale", "2").payload == {"state": {"scale": 2.0}}
    assert set_field("units", "imperial").payload == {"state": {"units": "imperial"}}
    assert set_field("refreshInterval", 30).payload == {"state": {"refreshInterval": 30.0}}

    assert set_field("days", "many").kind == "error"
    assert set_field("units", "kelvin").kind == "error"
    assert set_field("apiKey", "x").kind == "error"  # private
    assert set_field("layout", "{}").kind == "error"  # json: no entity
    assert set_field("nope", "x").kind == "error"
    assert resolve_command(Topic(3, 7, "set", "field"), "not json", frame, "scene-2").kind == "error"
    assert resolve_command(Topic(3, 7, "set", "field"), json.dumps({"scene": "zzz", "field": "city", "value": 1}), frame, "scene-2").kind == "error"


def test_field_of_another_scene_is_kept_for_its_next_activation():
    frame = frame_with_fields()
    action = resolve_command(
        Topic(3, 7, "set", "field"), json.dumps({"scene": "Weather", "field": "city", "value": "Oslo"}), frame, "scene-1"
    )
    assert (action.kind, action.scene_id, action.state) == ("store_field", "scene-2", {"city": "Oslo"})
    assert "kept" in action.summary


def test_command_topic_runs_events_and_scene_switches():
    frame = frame_with_fields()
    topic = Topic(3, 7, "command")
    switch = resolve_command(topic, json.dumps({"scene": "Weather", "state": {"city": "Paris"}}), frame, None, {"scene-2": {"days": 2}})
    assert switch.payload == {"sceneId": "scene-2", "state": {"days": 2, "city": "Paris"}}
    assert switch.consumes_pending == "scene-2"

    event = resolve_command(topic, json.dumps({"event": "setSceneState", "payload": {"state": {"city": "Rome"}}}), frame, None)
    assert (event.event, event.payload) == ("setSceneState", {"state": {"city": "Rome"}})
    custom = resolve_command(topic, json.dumps({"event": "myCustomEvent", "payload": {"x": 1}}), frame, None)
    assert (custom.event, custom.payload) == ("myCustomEvent", {"x": 1})
    bare = resolve_command(topic, json.dumps({"event": "render"}), frame, None)
    assert (bare.event, bare.payload) == ("render", {})

    # What the frame's own network API refuses with the access key, Home
    # Assistant does not get either (docs/events-contract.json `http:write`).
    for refused in ("restart", "reboot", "uploadScenes", "reload", "voiceChat", "init"):
        assert resolve_command(topic, json.dumps({"event": refused}), frame, None).kind == "error", refused
    assert resolve_command(topic, json.dumps({"event": "no spaces allowed"}), frame, None).kind == "error"
    assert resolve_command(topic, json.dumps({"event": "render", "payload": [1]}), frame, None).kind == "error"
    assert resolve_command(topic, json.dumps({"scene": "Weather", "state": "x"}), frame, None).kind == "error"
    assert resolve_command(topic, "[]", frame, None).kind == "error"
    assert resolve_command(topic, "", frame, None).kind == "error"


@pytest.mark.parametrize(
    "spec, value, expected",
    [
        ({"type": "boolean"}, "ON", True),
        ({"type": "boolean"}, 0, False),
        ({"type": "integer"}, "7", 7),
        ({"type": "float"}, "0.5", 0.5),
        ({"type": "string"}, 12, "12"),
        ({"type": "color"}, "#fff", "#fff"),
        ({"type": "string"}, {"a": 1}, '{"a": 1}'),
        ({"type": "select", "options": ["a", "b"]}, "b", "b"),
        ({"type": "select", "options": []}, "anything", "anything"),
    ],
)
def test_coerce_field_value(spec, value, expected):
    assert commands.coerce_field_value(spec, value) == expected


@pytest.mark.parametrize(
    "spec, value",
    [({"type": "boolean"}, "maybe"), ({"type": "integer"}, "1.5"), ({"type": "integer"}, True), ({"type": "float"}, "x")],
)
def test_coerce_field_value_refuses_the_wrong_shape(spec, value):
    with pytest.raises(ValueError):
        commands.coerce_field_value(spec, value)
