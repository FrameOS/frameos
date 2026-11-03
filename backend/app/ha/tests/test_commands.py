import json

from app.ha.commands import Topic, parse_topic, resolve_command
from app.ha.tests.test_discovery import make_frame, weather_scene


def frame_with_fields() -> dict:
    return make_frame(scenes=[{"id": "scene-1", "name": "Clock"}, weather_scene(), {"id": "scene-3", "name": "Photos"}])


def test_parse_topic_reads_the_frame_and_the_kind():
    assert parse_topic("frameos/frame/3/7/press") == Topic(3, 7, "press")
    assert parse_topic("frameos/frame/3/7/command") == Topic(3, 7, "command")
    assert parse_topic("frameos/frame/3/7/set/scene") == Topic(3, 7, "set", "scene")
    assert parse_topic("frameos/frame/3/7/set/display") == Topic(3, 7, "set", "display")
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


def test_scene_select():
    frame = frame_with_fields()
    plain = resolve_command(Topic(3, 7, "set", "scene"), "Weather", frame, "scene-1")
    assert (plain.event, plain.payload) == ("setCurrentScene", {"sceneId": "scene-2"})
    # By id works too; an unknown scene or setting is refused.
    assert resolve_command(Topic(3, 7, "set", "scene"), "scene-3", frame, None).payload == {"sceneId": "scene-3"}
    assert resolve_command(Topic(3, 7, "set", "scene"), "Nope", frame, None).kind == "error"
    assert resolve_command(Topic(3, 7, "set", "field"), "x", frame, None).kind == "error"


def test_command_topic_runs_events_and_scene_switches():
    frame = frame_with_fields()
    topic = Topic(3, 7, "command")
    switch = resolve_command(topic, json.dumps({"scene": "Weather", "state": {"city": "Paris"}}), frame, None)
    assert (switch.event, switch.payload) == ("setCurrentScene", {"sceneId": "scene-2", "state": {"city": "Paris"}})
    # Templates make text: a state value is typed by the scene's field where
    # it fits, and passed on as given where it does not or no field says.
    typed = resolve_command(
        topic,
        json.dumps({"scene": "Weather", "state": {"dark": "true", "days": "4", "scale": "2", "units": "kelvin", "extra": "x"}}),
        frame,
        None,
    )
    assert typed.payload["state"] == {"dark": True, "days": 4, "scale": 2.0, "units": "kelvin", "extra": "x"}

    event = resolve_command(topic, json.dumps({"event": "setSceneState", "payload": {"state": {"city": "Rome", "dark": "off"}}}), frame, "scene-2")
    assert (event.event, event.payload) == ("setSceneState", {"state": {"city": "Rome", "dark": False}})
    # The showing scene unknown: nothing to type against, the state goes as given.
    untyped = resolve_command(topic, json.dumps({"event": "setSceneState", "payload": {"state": {"dark": "off"}}}), frame, None)
    assert untyped.payload == {"state": {"dark": "off"}}
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
