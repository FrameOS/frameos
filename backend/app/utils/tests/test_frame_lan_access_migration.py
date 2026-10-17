"""The fb55350ce269 migration: frame.lan_access, ON for every frame that
exists, except the frames the backend renders itself, which keep what their
renderer obeyed before."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = ROOT / "backend" / "migrations" / "versions" / "fb55350ce269_frame_lan_access.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("frame_lan_access_migration", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migration = _load_migration()


def test_existing_frames_get_lan_access_and_new_rows_default_to_it_in_the_database():
    engine = sa.create_engine("sqlite://")
    meta = sa.MetaData()
    frame = sa.Table(
        "frame",
        meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String),
        sa.Column("mode", sa.String),
        sa.Column("device", sa.String),
        sa.Column("embedded", sa.JSON()),
        sa.Column("device_config", sa.JSON()),
        sa.Column("network", sa.JSON()),
    )
    meta.create_all(engine)
    rows = [
        {"id": 1, "mode": "rpios", "device": "web_only", "network": {"wifiHotspot": "disabled"}},
        # The legacy key is noise for a device frame: the device decides.
        {"id": 2, "mode": "buildroot", "device": "framebuffer", "network": {"allowLocalNetworkAccess": False}},
        {"id": 3, "mode": "embedded", "device": "waveshare.EPD_7in5_V2", "embedded": {"platform": "esp32-s3"}},
        {"id": 4, "mode": "embedded", "device": "virtual", "embedded": {"platform": "virtual"}},
        {"id": 5, "mode": "embedded", "device": "virtual", "embedded": {"platform": "virtual"},
         "network": {"allowLocalNetworkAccess": True}},
        {"id": 6, "mode": "embedded", "device": "pimoroni.inky", "embedded": {"platform": "pico-2w"}, "network": {}},
        {"id": 7, "mode": None, "device": None},
    ]
    with engine.begin() as connection:
        empty = {"mode": None, "device": None, "embedded": None, "device_config": None, "network": None}
        connection.execute(frame.insert(), [{**empty, "name": f"f{row['id']}", **row} for row in rows])

    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()

    with engine.begin() as connection:
        values = dict(connection.execute(sa.text("SELECT id, lan_access FROM frame")).all())
        # Inserted without a value, a row is a frame from before the switch.
        connection.execute(sa.text("INSERT INTO frame (id, name) VALUES (8, 'raw')"))
        raw = connection.execute(sa.text("SELECT lan_access FROM frame WHERE id = 8")).scalar()
    assert values == {1: 1, 2: 1, 3: 1, 4: 0, 5: 1, 6: 0, 7: 1}
    assert raw == 1


def test_new_frames_take_the_orm_default_off():
    from app.models.frame import Frame

    column = Frame.__table__.c.lan_access
    assert column.nullable is False
    assert column.default.arg is False
