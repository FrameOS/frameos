"""The frame's render scale in the device sync compare (frame.json `renderScale`)."""
from app.api import frame_sync


def test_the_render_scale_compares_as_a_number_with_zero_for_automatic():
    # A runtime from before the key reports none: that is the backend's
    # default (automatic), not a change to offer.
    assert frame_sync._sync_frame_value("render_scale", None) == 0
    assert frame_sync._sync_frame_value("render_scale", 0) == 0
    assert frame_sync._sync_frame_value("render_scale", 1.5) == 1.5
    assert frame_sync._sync_frame_value("render_scale", "2") == 2
    assert frame_sync._sync_frame_value("render_scale", 9) == 0
    assert frame_sync._sync_label("render_scale") == "Scale"
    assert "render_scale" in frame_sync.FRAME_SYNC_FRAME_KEYS


def test_an_old_runtime_without_the_key_shows_no_change():
    backend = {"render_scale": 0}
    section = frame_sync._build_frame_sync_section(backend, {}, backend)
    assert [change["path"] for change in section["changes"]] == []

    device = {"render_scale": 2}
    section = frame_sync._build_frame_sync_section(backend, device, backend)
    assert [change["path"] for change in section["changes"]] == ["render_scale"]
