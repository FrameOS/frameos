from app.utils.embedded_render import (
    _SAVED_ASSETS_MARKER,
    _STATE_MARKER,
    _parse_marker,
)

STDERR = """[scene] {"event":"render:done","sceneId":"scene-a","ms":1.0}
__FRAMEOS_SCENE_STATE__{"sceneId":"scene-a","state":{"word":"hi"},"seeded":true}
__FRAMEOS_SAVED_ASSETS__{"files":["wikicommons/a.jpg"],"skippedOverBudget":1}
"""


def test_parse_marker_extracts_each_payload():
    state = _parse_marker(STDERR, _STATE_MARKER)
    assert state == {"sceneId": "scene-a", "state": {"word": "hi"}, "seeded": True}
    saved = _parse_marker(STDERR, _SAVED_ASSETS_MARKER)
    assert saved == {"files": ["wikicommons/a.jpg"], "skippedOverBudget": 1}


def test_parse_marker_missing_and_invalid():
    assert _parse_marker("[scene] nothing here\n", _STATE_MARKER) is None
    assert _parse_marker(f"{_STATE_MARKER}not-json\n", _STATE_MARKER) is None
    # A spoofed marker mid-line does not match; only line starts count.
    assert _parse_marker(f"[scene] {_STATE_MARKER}{{}}\n", _STATE_MARKER) is None


def test_parse_marker_takes_last_line():
    text = (
        f'{_STATE_MARKER}{{"sceneId":"old"}}\n'
        f'{_STATE_MARKER}{{"sceneId":"new"}}\n'
    )
    assert _parse_marker(text, _STATE_MARKER) == {"sceneId": "new"}
