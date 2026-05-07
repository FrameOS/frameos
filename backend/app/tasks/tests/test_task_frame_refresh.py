from __future__ import annotations

import pytest

from app.database import SessionLocal
from app.models.frame import Frame
from app.tasks.utils import get_fresh_frame


def _frame(**overrides) -> Frame:
    values = {
        "name": "WorkerFrame",
        "mode": "rpios",
        "frame_host": "localhost",
        "frame_port": 8787,
        "frame_access_key": "key",
        "frame_access": "private",
        "ssh_user": "pi",
        "ssh_port": 22,
        "ssh_keys": ["default"],
        "server_host": "localhost",
        "server_port": 8989,
        "server_api_key": "server-key",
        "server_send_logs": True,
        "status": "uninitialized",
        "interval": 300,
        "metrics_interval": 60,
        "scenes": [],
        "apps": [],
        "scaling_mode": "contain",
        "rotate": 0,
        "assets_path": "/srv/assets",
        "save_assets": True,
        "upload_fonts": "",
    }
    values.update(overrides)
    return Frame(**values)


@pytest.mark.asyncio
async def test_get_fresh_frame_refreshes_long_lived_worker_session(db):
    frame = _frame()
    db.add(frame)
    db.commit()
    db.refresh(frame)
    frame_id = frame.id

    cached = db.get(Frame, frame_id)
    assert cached.ssh_keys == ["default"]

    other_db = SessionLocal()
    try:
        updated = other_db.get(Frame, frame_id)
        updated.ssh_keys = ["ha"]
        other_db.commit()
    finally:
        other_db.close()

    fresh = get_fresh_frame(db, frame_id)

    assert fresh is cached
    assert fresh.ssh_keys == ["ha"]
