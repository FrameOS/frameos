from app.models.frame import new_frame
from app.models.log import process_log, new_log, Log
from sqlalchemy.exc import IntegrityError
import pytest

@pytest.fixture
async def frame(db_session):
    f = await new_frame(db_session, "frame", "pi@192.168.1.1:8787", "server_host.com", "device_test")
    return f


@pytest.mark.asyncio
async def test_log_creation(db_session, frame):
    log = await new_log(db_session, frame.id, "info", "This is a test log message.")
    assert log.type == "info"
    assert log.line == "This is a test log message."
    assert log.frame_id == frame.id

@pytest.mark.asyncio
async def test_log_to_dict_method(db_session, frame):
    log = await new_log(db_session, frame.id, "warning", "Log to test to_dict method.")
    log_dict = log.to_dict()
    assert log_dict['type'] == "warning"
    assert log_dict['line'] == "Log to test to_dict method."
    assert log_dict['frame_id'] == frame.id

@pytest.mark.asyncio
async def test_old_logs_removal(db_session, frame):
    for old_log in db_session.query(Log).all():
        db_session.delete(old_log)
    for i in range(1101):
        await new_log(db_session, frame.id, "debug", f"Log number {i}")
    logs_count = db_session.query(Log).filter_by(frame_id=frame.id).count()
    assert logs_count == 1001  # 1101 - 100 = 1001

@pytest.mark.asyncio
async def test_process_log(db_session, frame):
    await process_log(db_session, frame, {'event': 'render'})
    assert frame.status == "preparing"
    await process_log(db_session, frame, {'event': 'render:done'})
    assert frame.status == "ready"

@pytest.mark.asyncio
async def test_log_without_frame(db_session, frame):
    with pytest.raises(IntegrityError):
        await new_log(db_session, None, "info", "Log without frame.")

@pytest.mark.asyncio
async def test_log_timestamp(db_session, frame):
    log = await new_log(db_session, frame.id, "info", "Testing log timestamp.")
    assert log.timestamp is not None

@pytest.mark.asyncio
async def test_different_log_types(db_session, frame):
    types = ["info", "warning", "error", "debug"]
    for type in types:
        log = await new_log(db_session, frame.id, type, f"This is a {type} log.")
        assert log.type == type

@pytest.mark.asyncio
async def test_process_log_events(db_session, frame):
    events = [
        ('render', 'preparing'),
        ('render:device', 'rendering'),
        ('render:done', 'ready'),
        ('config', 'ready')  # Assuming the frame was not 'ready' before
    ]

    for event, expected_status in events:
        await process_log(db_session, frame, {'event': event})
        assert frame.status == expected_status
