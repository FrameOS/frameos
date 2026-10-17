"""The 5e2a9c71d4b8 data migration: every stored JavaScript app gets the
config.json `permissions` its code calls for, the way the editor's save
(frontend/src/utils/sceneAccess.ts) would write it."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
import sqlalchemy as sa

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = ROOT / "backend" / "migrations" / "versions" / "5e2a9c71d4b8_app_permissions.py"
CORPUS = json.loads((ROOT / "docs" / "scene-access-fixtures.json").read_text())


def _load_migration():
    spec = importlib.util.spec_from_file_location("app_permissions_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


migration = _load_migration()


def _scene(code: str, config: str | None) -> dict:
    sources = {"app.ts": code}
    if config is not None:
        sources["config.json"] = config
    return {"id": "s", "nodes": [{"id": "a", "type": "app", "data": {"keyword": "myApp"}}], "apps": {"myApp": {"sources": sources}}}


@pytest.mark.parametrize("fixture", CORPUS["stamps"], ids=lambda fixture: fixture["name"])
def test_matches_the_editors_stamp(fixture):
    # The migration is the cloud's read-time stamp (`onlyMissing`): a list
    # already there, right or stale, is left as it is.
    stamped = migration._stamped([_scene(fixture["code"], fixture["config"])])
    has_list = fixture["config"] is not None and '"permissions"' in fixture["config"]
    expect = None if has_list and not fixture.get("onlyMissing") else fixture["expect"]
    if expect is None:
        assert stamped is None
    else:
        assert stamped[0]["apps"]["myApp"]["sources"]["config.json"] == expect
        # Running it again changes nothing.
        assert migration._stamped(stamped) is None


def test_reads_writes_and_streams():
    def permissions(code: str):
        stamped = migration._stamped([_scene(code, '{"name": "A"}')])
        return json.loads(stamped[0]["apps"]["myApp"]["sources"]["config.json"])["permissions"]

    assert permissions("frameos.listAssets('photos')") == ["assets"]
    assert permissions("frameos.deleteAsset('x')") == ["assets", "assets-write"]
    assert permissions("frameos.openAssetStream('x')") == ["assets"]
    assert permissions('frameos.openAssetStream("x", "r")') == ["assets"]
    assert permissions("frameos.openAssetStream('x', 'a')") == ["assets", "assets-write"]
    assert permissions("frameos.openAssetStream(path, mode)") == ["assets", "assets-write"]
    # Caching a download is the frame's, not the app's.
    assert permissions("frameos.fetchImage(url, { saveAsset: { name: 'x' } })") == []


def test_inline_node_apps_and_non_js_apps():
    scene = {
        "id": "s",
        "nodes": [
            {"id": "edited", "type": "app", "data": {"keyword": "x", "sources": {"app.js": "frameos.readAsset('a')"}}},
            {"id": "nim", "type": "app", "data": {"keyword": "y", "sources": {"app.nim": "discard"}}},
            {"id": "code", "type": "code", "data": {"codeJS": "frameos.readAsset('a')"}},
            {"id": "builtin", "type": "app", "data": {"keyword": "data/localImage"}},
        ],
    }
    stamped = migration._stamped([scene])
    nodes = {node["id"]: node for node in stamped[0]["nodes"]}
    assert json.loads(nodes["edited"]["data"]["sources"]["config.json"]) == {"permissions": ["assets"]}
    assert "config.json" not in nodes["nim"]["data"]["sources"]
    assert nodes["code"] == scene["nodes"][2]
    assert nodes["builtin"] == scene["nodes"][3]
    # The input is untouched: the migration works on a copy.
    assert "config.json" not in scene["nodes"][0]["data"]["sources"]


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
    writer = _scene("frameos.writeAsset('x', y)", '{\n  "name": "W"\n}\n')
    plain = {"id": "plain", "nodes": []}
    with engine.begin() as connection:
        connection.execute(
            frame.insert(),
            [
                {"id": 1, "scenes": [writer, plain], "last_successful_deploy": {"scenes": [writer], "frame": {"x": 1}}},
                {"id": 2, "scenes": [plain], "last_successful_deploy": None},
                {"id": 3, "scenes": None, "last_successful_deploy": None},
            ],
        )
        connection.execute(template.insert(), [{"id": "t", "scenes": [writer]}])

    with engine.begin() as connection:
        migration._stamp_frames(connection)
        migration._stamp_templates(connection)

    expected = '{\n  "name": "W",\n  "permissions": [\n    "assets",\n    "assets-write"\n  ]\n}\n'
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
