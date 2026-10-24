"""The frame's event map in the device sync compare (docs/events.md, "Event map")."""
from app.api import frame_sync


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
    assert frame_sync._sync_frame_push_off_value("event_map", None) == []
    assert frame_sync._sync_frame_push_off_value("gpio_buttons", None) == []
