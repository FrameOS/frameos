import json
from pathlib import Path

import pytest

from app.utils.scene_layouts import bad_layouts_message, scene_layout_problem

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "docs" / "scene-layout-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_what_can_be_a_layout(case):
    assert scene_layout_problem(case["scene"]) == case["problem"]


def test_only_scenes_marked_as_layouts_are_held_to_it():
    plain = {"id": "a", "name": "A", "settings": {}, "nodes": []}
    assert bad_layouts_message([plain]) is None
    assert bad_layouts_message(None) is None
    message = bad_layouts_message([plain, {"id": "b", "name": "Bar", "settings": {"isLayout": True}, "nodes": []}])
    assert message is not None and "'Bar'" in message
