"""The frame's event map in the device sync compare (docs/events.md, "Event map")."""
import json

from app.api import frame_sync
from app.models.frame import Frame


def test_the_frames_event_map_compares_as_its_rules():
    rule = {"event": "button", "match": {"label": "LEFT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "prev"}}
    # Nothing set on either side reads as nothing, whatever its spelling.
    assert frame_sync._sync_frame_value("event_map", None) is None
    assert frame_sync._sync_frame_value("event_map", []) is None
    assert frame_sync._sync_frame_value("event_map", [{"event": "button", "as": "not a rule"}]) is None
    # A map is its rules, non-rules dropped, so the device's copy and the
    # backend's compare equal when they mean the same thing.
    assert frame_sync._sync_frame_value("event_map", [rule, "nonsense"]) == [rule]
    assert frame_sync._sync_label("event_map") == "Button actions"


def test_clearing_the_event_map_pushes_an_empty_list():
    # A push leaves out what collapses to None, which would keep the device's
    # map; the explicit "off" form is the empty list, as for the buttons.
    assert frame_sync._sync_frame_push_off_value("event_map", []) == []
    assert frame_sync._sync_frame_push_off_value("gpio_buttons", None) == []
    payload = frame_sync.backend_state_push_payload(_hyperpixel(event_map=[]))
    assert payload["event_map"] == []


def test_a_frame_never_given_a_map_is_pushed_null_and_keeps_its_devices():
    # None is "never given one": the admin-API deploy sends null, which takes
    # `eventMap` out of the device's frame.json, so a HyperPixel keeps its edge
    # swipes (frameos/device_event_map.nim). `[]` turned them off (cloud-w,
    # 2026-11-25).
    payload = frame_sync.backend_state_push_payload(_hyperpixel(event_map=None))
    assert "event_map" in payload and payload["event_map"] is None
    assert '"event_map": null' in json.dumps(payload)


def test_a_frame_with_a_map_is_pushed_its_rules():
    rule = {"event": "edgeSwipe", "match": {"edge": "bottom"}, "emit": "sceneSwitcher", "as": {}}
    payload = frame_sync.backend_state_push_payload(_hyperpixel(event_map=[rule]))
    assert payload["event_map"] == [rule]


def _hyperpixel(**fields) -> Frame:
    return Frame(
        name="cloud-w",
        frame_host="10.0.0.7",
        frame_port=8787,
        device="pimoroni.hyperpixel4sq_touch",
        mode="buildroot",
        **fields,
    )
