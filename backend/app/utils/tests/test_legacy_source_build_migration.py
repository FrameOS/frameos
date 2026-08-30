"""The d4e6f8a0b2c4 data migration, run against an in-memory SQLite."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa

MIGRATION = Path(__file__).resolve().parents[3] / "migrations" / "versions" / "d4e6f8a0b2c4_legacy_source_build.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("legacy_source_build_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _frame_table(meta: sa.MetaData) -> sa.Table:
    return sa.Table(
        "frame",
        meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("mode", sa.String(32)),
        sa.Column("rpios", sa.JSON()),
        sa.Column("buildroot", sa.JSON()),
        sa.Column("scenes", sa.JSON()),
    )


def test_migration_opens_the_door_only_for_frames_that_already_build_from_source(monkeypatch):
    module = _load_migration()
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    table = _frame_table(meta)
    meta.create_all(engine)
    compiled = {"id": "nim", "settings": {"execution": "compiled"}}
    interpreted = {"id": "js", "settings": {"execution": "interpreted"}}
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [
                # compiled scene, default mode → door opens on rpios
                {"id": 1, "mode": "rpios", "rpios": {"platform": "pi"}, "buildroot": None, "scenes": [interpreted, compiled]},
                # explicit static, no compiled scenes → door opens
                {"id": 2, "mode": None, "rpios": {"compilationMode": "static"}, "buildroot": None, "scenes": []},
                # retired shared mode on a buildroot frame → door opens on buildroot
                {"id": 3, "mode": "buildroot", "rpios": {"compilationMode": "static"}, "buildroot": {"compilationMode": "shared-scenes"}, "scenes": None},
                # interpreted only, precompiled → untouched
                {"id": 4, "mode": "rpios", "rpios": {"compilationMode": "precompiled"}, "buildroot": None, "scenes": [interpreted]},
                # embedded frames never build → untouched even with a stray compiled scene
                {"id": 5, "mode": "embedded", "rpios": None, "buildroot": None, "scenes": [compiled]},
                # buildroot frame with a compiled scene but nothing stored yet → door opens on buildroot
                {"id": 6, "mode": "buildroot", "rpios": None, "buildroot": None, "scenes": [compiled]},
            ],
        )

    monkeypatch.setattr(module.op, "get_bind", lambda: connection_holder[0], raising=False)
    connection_holder = [None]
    with engine.begin() as connection:
        connection_holder[0] = connection
        module.upgrade()

    with engine.connect() as connection:
        rows = {
            row_id: (rpios, buildroot)
            for row_id, rpios, buildroot in connection.execute(sa.select(table.c.id, table.c.rpios, table.c.buildroot)).all()
        }

    assert rows[1] == ({"platform": "pi", "legacySourceBuild": True}, None)
    assert rows[2] == ({"compilationMode": "static", "legacySourceBuild": True}, None)
    assert rows[3] == ({"compilationMode": "static"}, {"compilationMode": "shared-scenes", "legacySourceBuild": True})
    assert rows[4] == ({"compilationMode": "precompiled"}, None)
    assert rows[5] == (None, None)
    assert rows[6] == (None, {"legacySourceBuild": True})
