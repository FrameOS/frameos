"""The daf089223283 data migration (retire data/frameOSGallery), run against an in-memory SQLite."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa

MIGRATION = (
    Path(__file__).resolve().parents[3] / "migrations" / "versions" / "daf089223283_retire_nim_frameos_gallery.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("retire_nim_frameos_gallery_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _nim_scene(scene_id: str) -> dict:
    return {
        "id": scene_id,
        "nodes": [
            {"id": "n1", "type": "app", "data": {"keyword": "data/frameOSGallery", "config": {"category": "low-poly-animals"}}}
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

    gallery = frames[1].scenes[0]
    assert gallery["nodes"][0]["data"] == {"keyword": "frameOSGallery", "config": {"category": "low-poly-animals"}}
    assert gallery["apps"]["frameOSGallery"]["origin"] == "repo/apps/image/frameOSGallery"
    assert frames[1].scenes[1] == untouched
    baseline = frames[1].last_successful_deploy
    assert baseline["name"] == "Frame"
    assert baseline["scenes"][0]["nodes"][0]["data"]["keyword"] == "frameOSGallery"
    assert frames[2].scenes == [untouched]
    assert frames[3].scenes is None
    assert frames[3].last_successful_deploy == {"name": "no scenes"}
    assert templates["t1"][0]["nodes"][0]["data"]["keyword"] == "frameOSGallery"

    # Running it again changes nothing.
    with engine.begin() as connection:
        module._retire_frames(connection)
        module._retire_templates(connection)
    with engine.connect() as connection:
        again = {row.id: row for row in connection.execute(sa.select(frame)).all()}
    assert again[1].scenes == frames[1].scenes
