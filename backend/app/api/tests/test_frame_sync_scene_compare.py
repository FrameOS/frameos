"""Scene comparison in frame sync must treat a missing execution mode as interpreted."""
from app.api.frame_sync import _scene_sync_values_equal


def test_stamped_and_unstamped_interpreted_scenes_compare_equal():
    device_copy = {"id": "s1", "name": "Scene", "nodes": [], "edges": []}
    backend_copy = {"id": "s1", "name": "Scene", "nodes": [], "edges": [], "settings": {"execution": "interpreted"}}
    assert _scene_sync_values_equal(device_copy, backend_copy)
    assert _scene_sync_values_equal(backend_copy, device_copy)


def test_compiled_is_still_a_real_difference():
    device_copy = {"id": "s1", "name": "Scene", "nodes": [], "edges": []}
    backend_copy = {"id": "s1", "name": "Scene", "nodes": [], "edges": [], "settings": {"execution": "compiled"}}
    assert not _scene_sync_values_equal(device_copy, backend_copy)
    assert _scene_sync_values_equal(
        {"settings": {"execution": "compiled", "refreshInterval": 60}},
        {"settings": {"refreshInterval": 60, "execution": "compiled"}},
    )


def test_the_installed_copys_event_map_is_part_of_the_scene_on_the_device():
    # docs/events.md "Event map": the map travels beside the scene, so a frame
    # whose scenes.json predates a remap is out of sync until the next push.
    device_copy = {"id": "s1", "name": "Scene", "nodes": [], "edges": []}
    mapped = {**device_copy, "eventMap": [{"event": "button", "match": {"label": "REFRESH"}, "as": {"label": "A"}}]}
    assert not _scene_sync_values_equal(device_copy, mapped)
    assert _scene_sync_values_equal({**device_copy, "eventMap": []}, device_copy)
