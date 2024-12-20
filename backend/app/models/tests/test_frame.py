import pytest
from app.models.frame import Frame, new_frame, update_frame, delete_frame

@pytest.mark.asyncio
async def test_frame_creation(db_session):
    frame = await new_frame(db_session, "frame2", "pi@192.168.1.1:8787", "server_host.com", "device_test")
    assert frame.name == "frame2"
    assert frame.frame_host == "192.168.1.1"
    assert frame.frame_port == 8787
    assert frame.ssh_user == "pi"
    assert frame.ssh_pass is None
    assert frame.server_host == "server_host.com"
    assert frame.server_port == 8989
    assert frame.interval == 60
    assert frame.device == "device_test"

@pytest.mark.asyncio
async def test_frame_update(db_session):
    frame = await new_frame(db_session, "frame", "pi@192.168.1.1", "server_host.com", None)
    frame.frame_host = "updated_host.com"
    await update_frame(db_session, frame)
    updated_frame: Frame = db_session.query(Frame).get(frame.id)
    assert updated_frame.frame_host == "updated_host.com"

@pytest.mark.asyncio
async def test_frame_delete(db_session):
    frame = await new_frame(db_session, "frame", "pi@192.168.1.1", "server_host.com", None)
    result = await delete_frame(db_session, frame.id)
    assert result is True
    deleted_frame = db_session.query(Frame).get(frame.id)
    assert deleted_frame is None

@pytest.mark.asyncio
async def test_to_dict_method(db_session):
    frame = await new_frame(db_session, "frame", "pi@192.168.1.1", "server_host.com", None, 55)
    frame_dict = frame.to_dict()
    assert frame_dict['frame_host'] == "192.168.1.1"
    assert frame_dict['frame_port'] == 8787
    assert frame_dict['ssh_user'] == "pi"
    assert frame_dict['ssh_pass'] is None
    assert frame_dict['ssh_port'] == 22
    assert frame_dict['server_host'] == "server_host.com"
    assert frame_dict['server_port'] == 8989
    assert frame_dict['device'] == 'web_only'
    assert frame_dict['interval'] == 55

@pytest.mark.asyncio
async def test_get_frame_by_host(db_session):
    frame1 = await new_frame(db_session, "frame", "pi@192.168.1.1", "server_host.com", None)
    frame2 = await new_frame(db_session, "frame", "pi@192.168.1.2", "server_host.com", None)
    frames_from_host = db_session.query(Frame).filter_by(frame_host="192.168.1.1").all()
    assert frame1 in frames_from_host
    assert frame2 not in frames_from_host

@pytest.mark.asyncio
async def test_delete_nonexistent_frame(db_session):
    result = await delete_frame(db_session, 99999)  # Non-existent ID
    assert result is False

@pytest.mark.asyncio
async def test_max_frame_port_limit(db_session):
    with pytest.raises(ValueError):
        await new_frame(db_session, "frame", "pi@192.168.1.1:70000", "server_host.com", None)