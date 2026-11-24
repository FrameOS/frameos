"""The c4e8a1b7d3f6 data migration: every stored JavaScript app that calls
`frameos.storeAction` asks for "store" in its config.json `permissions`, the
way the editor's save (frontend/src/utils/sceneAccess.ts) writes it from
2026.11.15, so a Scene store installed before the permission existed keeps
installing."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import sqlalchemy as sa

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = ROOT / "backend" / "migrations" / "versions" / "c4e8a1b7d3f6_store_permission.py"
CALL = "export function get() { frameos.storeAction('install', { store }) }"


def _load_migration():
    spec = importlib.util.spec_from_file_location("store_permission_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


migration = _load_migration()


def _scene(code: str, config: str | None) -> dict:
    sources = {"app.tsx": code}
    if config is not None:
        sources["config.json"] = config
    return {"id": "s", "nodes": [{"id": "a", "type": "app", "data": {"keyword": "myApp"}}], "apps": {"myApp": {"sources": sources}}}


def _config(stamped) -> str:
    return stamped[0]["apps"]["myApp"]["sources"]["config.json"]


def test_a_list_gains_the_name_and_keeps_the_rest():
    stamped = migration._stamped([_scene(CALL, '{\n  "name": "Store",\n  "permissions": [\n    "assets"\n  ],\n  "fields": []\n}\n')])
    assert _config(stamped) == '{\n  "name": "Store",\n  "permissions": [\n    "assets",\n    "store"\n  ],\n  "fields": []\n}\n'
    # Running it again changes nothing.
    assert migration._stamped(stamped) is None


def test_an_app_with_no_list_gets_one():
    stamped = migration._stamped([_scene(CALL, '{\n    "name": "Store",\n    "settings": []\n}')])
    assert _config(stamped) == '{\n    "name": "Store",\n    "settings": [],\n    "permissions": [\n        "store"\n    ]\n}'
    assert json.loads(_config(migration._stamped([_scene(CALL, None)]))) == {"permissions": ["store"]}


def test_what_does_not_call_the_store_is_left_alone():
    assert migration._stamped([_scene("export function get() { return frameos.store() }", '{"permissions": []}')]) is None
    assert migration._stamped([_scene("frameos.frame('read')", '{"permissions": ["frame"]}')]) is None
    assert migration._stamped([{"id": "plain", "nodes": []}]) is None
    assert migration._stamped(None) is None


def test_what_cannot_be_read_is_left_alone():
    # Not strict JSON: a frame gives such an app nothing, and no list written
    # here would change that.
    assert migration._stamped([_scene(CALL, '{\n  "permissions": [],\n}')]) is None
    assert migration._stamped([_scene(CALL, '{"permissions": [] /* none */}')]) is None
    assert migration._stamped([_scene(CALL, '["store"]')]) is None
    # A list that is no list, and one that names it already.
    assert migration._stamped([_scene(CALL, '{"permissions": "all"}')]) is None
    assert migration._stamped([_scene(CALL, '{"permissions": ["store"]}')]) is None


def test_inline_node_apps_too():
    scene = {
        "id": "s",
        "nodes": [
            {"id": "edited", "type": "app", "data": {"keyword": "x", "sources": {"app.js": "frameos . storeAction ('remove', {})", "config.json": '{"permissions": []}'}}},
            {"id": "code", "type": "code", "data": {"codeJS": "frameos.storeAction('remove', {})"}},
        ],
    }
    stamped = migration._stamped([scene])
    nodes = {node["id"]: node for node in stamped[0]["nodes"]}
    assert json.loads(nodes["edited"]["data"]["sources"]["config.json"]) == {"permissions": ["store"]}
    assert nodes["code"] == scene["nodes"][1]
    # The input is untouched: the migration works on a copy.
    assert scene["nodes"][0]["data"]["sources"]["config.json"] == '{"permissions": []}'


def test_upgrade_stamps_frames_their_baseline_and_templates():
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    frame = sa.Table(
        "frame",
        meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scenes", sa.JSON()),
        sa.Column("last_successful_deploy", sa.JSON()),
    )
    template = sa.Table("template", meta, sa.Column("id", sa.String, primary_key=True), sa.Column("scenes", sa.JSON()))
    meta.create_all(engine)
    store = _scene(CALL, '{\n  "name": "Store",\n  "permissions": []\n}\n')
    plain = {"id": "plain", "nodes": []}
    with engine.begin() as connection:
        connection.execute(
            frame.insert(),
            [
                {"id": 1, "scenes": [store, plain], "last_successful_deploy": {"scenes": [store], "frame": {"x": 1}}},
                {"id": 2, "scenes": [plain], "last_successful_deploy": None},
                {"id": 3, "scenes": None, "last_successful_deploy": None},
            ],
        )
        connection.execute(template.insert(), [{"id": "t", "scenes": [store]}])

    with engine.begin() as connection:
        migration._stamp_frames(connection)
        migration._stamp_templates(connection)

    expected = '{\n  "name": "Store",\n  "permissions": [\n    "store"\n  ]\n}\n'
    with engine.connect() as connection:
        frames = {row.id: row for row in connection.execute(sa.select(frame)).all()}
        templates = dict(connection.execute(sa.select(template.c.id, template.c.scenes)).all())
    assert frames[1].scenes[0]["apps"]["myApp"]["sources"]["config.json"] == expected
    assert frames[1].scenes[1] == plain
    assert frames[1].last_successful_deploy["scenes"][0]["apps"]["myApp"]["sources"]["config.json"] == expected
    assert frames[1].last_successful_deploy["frame"] == {"x": 1}
    assert frames[2].scenes == [plain]
    assert frames[3].scenes is None
    assert templates["t"][0]["apps"]["myApp"]["sources"]["config.json"] == expected
