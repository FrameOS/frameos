import pytest
from unittest.mock import patch, AsyncMock
from datetime import datetime, timedelta, timezone
from app.models.frame import new_frame, Frame
from app.models.log import LOG_LIMIT_PER_FRAME, new_log, process_log, Log
from app.codegen.drivers_nim import frame_compilation_mode
from app.tasks.buildroot_image import (
    BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
    SUPPORTED_BUILDROOT_PLATFORM,
    buildroot_sd_image_config_fingerprint,
)

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

    await new_log(db, redis, frame.id, "webhook", "Sample log", timestamp=timestamp)

    updated = db.get(Frame, frame.id)
    assert updated.last_log_at == timestamp


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log_ignores_frame_image_fetch_errors_for_last_log_at(mock_pub, db, redis):
    frame = await new_frame(db, redis, "LogFrame", "localhost", "server_host")
    original_last_log_at = frame.last_log_at
    timestamp = (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(tzinfo=None)

    for log_type in ("stderr", "info"):
        await new_log(
            db,
            redis,
            frame.id,
            log_type,
            f"Error fetching image from frame {frame.id}: 502: All connection attempts failed",
            timestamp=timestamp,
        )

    updated = db.get(Frame, frame.id)
    assert updated.last_log_at == original_last_log_at


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log_ignores_backend_connection_logs_for_last_log_at(mock_pub, db, redis):
    frame = await new_frame(db, redis, "LogFrame", "localhost", "server_host")
    original_last_log_at = frame.last_log_at
    timestamp = (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(tzinfo=None)

    for line in (
        "Connecting via SSH to pi@10.8.0.62 (keypair: Default)",
        "Unable to connect to 10.8.0.62:22 via SSH: [Errno 51] Connect call failed ('10.8.0.62', 22)",
        "SSH connection idle for 30s, closing until further commands",
        "Error on frame event uploadScenes: All connection attempts failed",
        "Error on upload scenes request: All connection attempts failed",
    ):
        await new_log(db, redis, frame.id, "stdinfo", line, timestamp=timestamp)

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
    boot_time = datetime(2026, 6, 2, 3, 4, 5)
    await process_log(db, redis, frame, [
        boot_time.replace(tzinfo=timezone.utc).timestamp(),
        {
            "event": "bootup",
            "width": 200,
            "height": 300,
            "color": "monochrome",
            "config": {
                "timeZone": "Custom/Zone",
            },
        },
    ])
    updated = db.get(Frame, frame.id)
    assert updated.status == "ready"
    assert updated.width == 200
    assert updated.height == 300
    assert updated.color == "monochrome"
    assert updated.timezone == "Custom/Zone"


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_process_log_bootup_does_not_override_configured_resolution(mock_pub, db, redis):
    frame = await new_frame(db, redis, "BootFrame", "localhost", "server_host")
    frame.width = 800
    frame.height = 480
    db.add(frame)
    db.commit()

    await process_log(db, redis, frame, {
        "event": "bootup",
        "config": {
            "width": 720,
            "height": 576,
        },
    })

    updated = db.get(Frame, frame.id)
    assert updated.width == 800
    assert updated.height == 480


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_process_log_bootup_does_not_override_stored_timezone(mock_pub, db, redis):
    frame = await new_frame(db, redis, "BootFrame", "localhost", "server_host")
    frame.timezone = "Europe/Brussels"
    db.add(frame)
    db.commit()

    await process_log(
        db,
        redis,
        frame,
        {
            "event": "bootup",
            "config": {
                "timeZone": "America/New_York",
            },
        },
    )

    updated = db.get(Frame, frame.id)
    assert updated.timezone == "Europe/Brussels"


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_process_log_bootup_marks_matching_buildroot_sd_image_deployed(mock_pub, db, redis):
    frame = await new_frame(db, redis, "BuildrootBootFrame", "frame53.local", "server_host")
    frame.mode = "buildroot"
    frame.status = "uninitialized"
    frame.buildroot = {
        "platform": SUPPORTED_BUILDROOT_PLATFORM,
        "sdImage": {
            "status": "ready",
            "platform": SUPPORTED_BUILDROOT_PLATFORM,
            "frameosVersion": "2026.6.2",
            "customizationVersion": BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
            "compilationMode": frame_compilation_mode(frame),
        },
    }
    db.add(frame)
    db.commit()
    db.refresh(frame)
    sd_image = dict(frame.buildroot["sdImage"])
    sd_image["configFingerprint"] = buildroot_sd_image_config_fingerprint(frame)
    frame.buildroot = {**frame.buildroot, "sdImage": sd_image}
    db.add(frame)
    db.commit()

    await process_log(db, redis, frame, {"event": "bootup", "width": 200, "height": 300})

    updated = db.get(Frame, frame.id)
    assert updated.last_successful_deploy_at is not None
    assert updated.last_successful_deploy["frameos_version"] == "2026.6.2"
    assert updated.last_successful_deploy["width"] == 200
    assert updated.last_successful_deploy["height"] == 300
    assert updated.status == "ready"

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_new_log_trimming(mock_pub, db, redis):
    frame = await new_frame(db, redis, "TrimFrame", "localhost", "server_host")
    # Clear existing logs
    db.query(Log).delete()
    db.commit()

    # Seed logs up to the trim threshold, then add one via new_log to trigger pruning.
    db.add_all(
        [
            Log(project_id=frame.project_id, frame_id=frame.id, type="info", line=f"Log {i}")
            for i in range(LOG_LIMIT_PER_FRAME + 100)
        ]
    )
    db.commit()
    # The prune count runs only every PRUNE_CHECK_EVERY inserts; reset the
    # throttle so this insert performs the check.
    from app.models.log import _inserts_since_prune_check
    _inserts_since_prune_check.clear()
    await new_log(db, redis, frame.id, "info", "Trigger trim")
    count = db.query(Log).filter_by(frame_id=frame.id).count()
    # Pruning trims back down to exactly the limit; the new log survives.
    assert count == LOG_LIMIT_PER_FRAME
    assert db.query(Log).filter_by(frame_id=frame.id).order_by(Log.id.desc()).first().line == "Trigger trim"


@pytest.mark.asyncio
async def test_new_log_commits_before_publishing(db, redis):
    """new_log must not await while a write transaction is open: the session is
    sync SQLAlchemy on the event loop, so a task suspended mid-publish would
    hold the SQLite write lock while other requests block the loop waiting for
    it ("database is locked" storms in production)."""
    with patch("app.models.log.publish_message", new_callable=AsyncMock):
        frame = await new_frame(db, redis, "PublishFrame", "localhost", "server_host")

    tx_open_during_publish = None

    async def record_tx_state(_redis, _event, _payload):
        nonlocal tx_open_during_publish
        tx_open_during_publish = db.in_transaction()

    with patch("app.models.log.publish_message", record_tx_state):
        await new_log(db, redis, frame.id, "webhook", '{"event":"test"}')

    assert tx_open_during_publish is False
