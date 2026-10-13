"""The 1329ea888ea9 data migration (retire eight Nim data apps), run against an in-memory SQLite."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa

MIGRATION = (
    Path(__file__).resolve().parents[3] / "migrations" / "versions" / "1329ea888ea9_retire_nim_data_apps.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("retire_nim_data_apps_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _nim_scene(scene_id: str) -> dict:
    return {
        "id": scene_id,
        "nodes": [
            {"id": "n1", "type": "app", "data": {"keyword": "data/weather", "config": {"location": "Brussels"}}},
            {"id": "n2", "type": "app", "data": {"keyword": "data/unsplash", "config": {"search": "fox"}}},
            # Already retired by the previous migration: left alone here.
            {"id": "n3", "type": "app", "data": {"keyword": "data/frameOSGallery", "config": {}}},
        ],
        "settings": {"execution": "interpreted"},
    }


def test_migration_rewrites_frames_baselines_and_templates():
    module = _load_migration()
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    frame = sa.Table(
        "frame", meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scenes", sa.JSON()),
        sa.Column("last_successful_deploy", sa.JSON()),
    )
    template = sa.Table(
        "template", meta,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("scenes", sa.JSON()),
    )
    meta.create_all(engine)
    untouched = {"id": "clock", "nodes": [{"id": "c", "type": "app", "data": {"keyword": "data/clock"}}]}
    with engine.begin() as connection:
        connection.execute(frame.insert(), [
            {"id": 1, "scenes": [_nim_scene("gallery"), untouched],
             "last_successful_deploy": {"name": "Frame", "scenes": [_nim_scene("gallery")]}},
            {"id": 2, "scenes": [untouched], "last_successful_deploy": None},
            {"id": 3, "scenes": None, "last_successful_deploy": {"name": "no scenes"}},
        ])
        connection.execute(template.insert(), [{"id": "t1", "scenes": [_nim_scene("tpl")]}])

    with engine.begin() as connection:
        module._retire_frames(connection)
        module._retire_templates(connection)

    with engine.connect() as connection:
        frames = {row.id: row for row in connection.execute(sa.select(frame)).all()}
        templates = dict(connection.execute(sa.select(template.c.id, template.c.scenes)).all())

    converted = frames[1].scenes[0]
    assert converted["nodes"][0]["data"] == {"keyword": "weather", "config": {"location": "Brussels"}}
    assert converted["nodes"][1]["data"] == {"keyword": "unsplash", "config": {"search": "fox"}}
    assert converted["nodes"][2]["data"]["keyword"] == "data/frameOSGallery"
    assert converted["apps"]["weather"]["origin"] == "repo/apps/code/weather"
    assert converted["apps"]["unsplash"]["origin"] == "repo/apps/code/unsplash"
    assert set(converted["apps"]) == {"weather", "unsplash"}
    assert frames[1].scenes[1] == untouched
    baseline = frames[1].last_successful_deploy
    assert baseline["name"] == "Frame"
    assert baseline["scenes"][0]["nodes"][0]["data"]["keyword"] == "weather"
    assert frames[2].scenes == [untouched]
    assert frames[3].scenes is None
    assert frames[3].last_successful_deploy == {"name": "no scenes"}
    assert templates["t1"][0]["nodes"][1]["data"]["keyword"] == "unsplash"

    # Running it again changes nothing.
    with engine.begin() as connection:
        module._retire_frames(connection)
        module._retire_templates(connection)
    with engine.connect() as connection:
        again = {row.id: row for row in connection.execute(sa.select(frame)).all()}
    assert again[1].scenes == frames[1].scenes
