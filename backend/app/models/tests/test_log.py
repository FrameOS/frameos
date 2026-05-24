import pytest
from unittest.mock import patch, AsyncMock
from datetime import datetime, timedelta, timezone
from app.models.frame import new_frame, Frame
from app.models.log import LOG_LIMIT_PER_FRAME, new_log, process_log, Log

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
async def test_new_log_updates_frame_last_log_at(mock_pub, db, redis):
    frame = await new_frame(db, redis, "LogFrame", "localhost", "server_host")
    timestamp = (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(tzinfo=None)

    await new_log(db, redis, frame.id, "info", "Sample log", timestamp=timestamp)

    updated = db.get(Frame, frame.id)
    assert updated.last_log_at == timestamp


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log_ignores_frame_image_fetch_errors_for_last_log_at(mock_pub, db, redis):
    frame = await new_frame(db, redis, "LogFrame", "localhost", "server_host")
    original_last_log_at = frame.last_log_at
    timestamp = (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(tzinfo=None)

    await new_log(
        db,
        redis,
        frame.id,
        "stderr",
        f"Error fetching image from frame {frame.id}: 502: All connection attempts failed",
        timestamp=timestamp,
    )

    updated = db.get(Frame, frame.id)
    assert updated.last_log_at == original_last_log_at

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

    # Seed logs up to the trim threshold, then add one via new_log to trigger pruning.
    db.add_all([Log(frame_id=frame.id, type="info", line=f"Log {i}") for i in range(LOG_LIMIT_PER_FRAME + 100)])
    db.commit()
    await new_log(db, redis, frame.id, "info", "Trigger trim")
    count = db.query(Log).filter_by(frame_id=frame.id).count()
    assert count == LOG_LIMIT_PER_FRAME + 1
