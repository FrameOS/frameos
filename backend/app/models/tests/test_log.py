import pytest
from unittest.mock import patch, AsyncMock
from app.models.frame import new_frame, Frame
from app.models.log import new_log, process_log, Log

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log(mock_pub, db, redis):
    frame = await new_frame(db, redis, "LogFrame", "localhost", "server_host")
    log_entry = await new_log(db, redis, frame.id, "info", "Sample log")
    assert log_entry.id is not None
    assert log_entry.type == "info"
    assert "Sample log" in log_entry.line
    assert log_entry.frame_id == frame.id
    # First publish_message: "new_frame", second: "new_log"
    assert mock_pub.await_count == 2

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_process_log_render(mock_pub, db, redis):
    frame = await new_frame(db, redis, "RenderFrame", "localhost", "server_host")
    # event=render => sets status='preparing'
    assert mock_pub.await_count == 1
    await process_log(db, redis, frame, {"event": "render"})
    assert mock_pub.await_count == 2
    updated = db.get(Frame, frame.id)
    assert updated.status == "preparing"

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_process_log_bootup(mock_pub, db, redis):
    frame = await new_frame(db, redis, "BootFrame", "localhost", "server_host")
    await process_log(db, redis, frame, {
        "event": "bootup",
        "width": 200,
        "height": 300,
        "color": "monochrome"
    })
    updated = db.get(Frame, frame.id)
    assert updated.status == "ready"
    assert updated.width == 200
    assert updated.height == 300
    assert updated.color == "monochrome"

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log_trimming(mock_pub, db, redis):
    frame = await new_frame(db, redis, "TrimFrame", "localhost", "server_host")
    # Clear existing logs
    db.query(Log).delete()
    db.commit()

    # Insert 1200 logs => older logs should be truncated to keep total at 1100
    for i in range(1200):
        await new_log(db, redis, frame.id, "info", f"Log {i}")
    count = db.query(Log).filter_by(frame_id=frame.id).count()
    assert count == 1100
