"""The c3d5e7f9a1b2 data migration, run against an in-memory SQLite."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa

MIGRATION = Path(__file__).resolve().parents[3] / "migrations" / "versions" / "c3d5e7f9a1b2_scene_execution_interpreted_default.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("scene_execution_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_migration_stamps_frames_and_templates_once():
    module = _load_migration()
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    tables = {
        name: sa.Table(name, meta, sa.Column("id", sa.Integer, primary_key=True), sa.Column("scenes", sa.JSON()))
        for name in ("frame", "template")
    }
    meta.create_all(engine)
    nim_scene = {"id": "nim", "nodes": [{"id": "s", "type": "source", "data": {}}]}
    with engine.begin() as connection:
        connection.execute(
            tables["frame"].insert(),
            [
                {"id": 1, "scenes": [{"id": "plain", "nodes": []}, nim_scene]},
                {"id": 2, "scenes": [{"id": "done", "settings": {"execution": "interpreted"}}]},
                {"id": 3, "scenes": None},
            ],
        )
        connection.execute(tables["template"].insert(), [{"id": 1, "scenes": [{"id": "tpl", "nodes": []}]}])

    with engine.begin() as connection:
        module._stamp_scenes(connection, "frame")
        module._stamp_scenes(connection, "template")

    with engine.connect() as connection:
        frames = dict(connection.execute(sa.select(tables["frame"].c.id, tables["frame"].c.scenes)).all())
        templates = dict(connection.execute(sa.select(tables["template"].c.id, tables["template"].c.scenes)).all())

    assert [scene["settings"]["execution"] for scene in frames[1]] == ["interpreted", "compiled"]
    assert frames[2] == [{"id": "done", "settings": {"execution": "interpreted"}}]
    assert frames[3] is None
    assert templates[1] == [{"id": "tpl", "nodes": [], "settings": {"execution": "interpreted"}}]
