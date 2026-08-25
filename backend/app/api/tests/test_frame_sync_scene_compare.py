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
