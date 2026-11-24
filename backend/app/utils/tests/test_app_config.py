"""An app's config.json, read the one way every reader reads it
(app/utils/app_config.py). docs/app-config-fixtures.json is the corpus the
runtime (test_app_config_fixtures.nim) and the SPA
(shared-spa/app-config-fixtures.test.ts) replay too: a file one of them
reads and another does not is a permission somebody never saw."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api.panel_code import UNREADABLE_CONFIG_PERMISSIONS, declared_grants, scene_refusal
from app.utils.app_config import (
    APP_CONFIG_MAX_DEPTH,
    bad_app_configs_message,
    parse_app_config,
    scene_app_config_problem,
)

ROOT = Path(__file__).resolve().parents[4]
CORPUS = json.loads((ROOT / "docs" / "app-config-fixtures.json").read_text())


def _text(fixture: dict) -> str:
    """`nest`: {"permissions":["frame"],"x":[[…]]} that many containers deep,
    the object included."""
    if "nest" not in fixture:
        return fixture["text"]
    arrays = fixture["nest"] - 1
    return '{"permissions":["frame"],"x":' + "[" * arrays + "]" * arrays + "}"


def _scene(config: str) -> dict:
    return {
        "id": "s",
        "name": "Scene",
        "nodes": [{"id": "a", "type": "app", "data": {"keyword": "myApp"}}],
        "apps": {"myApp": {"sources": {"app.ts": "export function get() { return 1 }", "config.json": config}}},
    }


def test_the_depth_is_the_contracts():
    assert CORPUS["maxDepth"] == APP_CONFIG_MAX_DEPTH


@pytest.mark.parametrize("fixture", CORPUS["cases"], ids=lambda fixture: fixture["name"])
def test_every_case(fixture):
    text = _text(fixture)
    config = parse_app_config(text)
    assert (config is not None) == fixture["config"]
    scene = _scene(text)
    permissions, settings = declared_grants(scene)
    if not fixture["config"]:
        # No config: no door saves it, and what it asks for is everything.
        assert scene_app_config_problem(scene) is not None
        assert scene_refusal(scene) == "invalid_app_config"
        assert permissions == set(UNREADABLE_CONFIG_PERMISSIONS)
        assert settings == set()
        return
    assert scene_app_config_problem(scene) is None
    listed = config.get("permissions")
    known = [name for name in CORPUS["permissions"] if isinstance(listed, list) and name in listed]
    assert (known if isinstance(listed, list) else None) == fixture["permissions"]
    # The panel's reading keeps a name it does not know (it then widens
    # whatever it is compared with, which is the careful side): the names
    # every reader knows are the contract.
    assert {name for name in permissions if name in CORPUS["permissions"]} == set(fixture["permissions"] or [])
    assert sorted(settings) == sorted(fixture["settings"])


def test_a_config_that_is_no_text_is_no_config():
    assert parse_app_config(None) is None
    assert parse_app_config({"permissions": ["frame"]}) is None
    assert parse_app_config(b"{}") is None


def test_the_message_names_the_app_and_the_scene():
    good = _scene('{"permissions": []}')
    assert bad_app_configs_message([good]) is None
    assert bad_app_configs_message(None) is None
    bad = _scene('{"permissions": ["frame"],}')
    message = bad_app_configs_message([good, bad])
    assert message is not None and '"myApp"' in message and '"Scene"' in message
    # A node's own files count too.
    inline = {"id": "s", "nodes": [{"id": "n", "type": "app", "data": {"keyword": "x", "sources": {"config.json": "{//\n}"}}}]}
    assert '"x"' in (bad_app_configs_message([inline]) or "")
    # An app with no config.json at all asks for nothing, and is fine.
    assert bad_app_configs_message([{"id": "s", "apps": {"a": {"sources": {"app.ts": "1"}}}}]) is None
