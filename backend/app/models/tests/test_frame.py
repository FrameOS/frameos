import pytest
from unittest.mock import patch, AsyncMock
from app.models.frame import new_frame, update_frame, delete_frame, Frame

@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)  # mock out the websocket broadcast
async def test_new_frame(mock_publish, db, redis):
    frame = await new_frame(
        db,
        redis,
        name="TestFrame",
        frame_host="pi@192.168.1.1:8787",
        server_host="server_host.com",
        device="testDevice",
        interval=123
    )
    assert frame.id is not None
    assert frame.name == "TestFrame"
    assert frame.frame_host == "192.168.1.1"
    assert frame.frame_port == 8787
    assert frame.ssh_user == "pi"
    assert frame.device == "testDevice"
    assert frame.interval == 123
    assert frame.enable_tls is True
    assert frame.expose_only_tls_port is True
    assert frame.tls_server_cert and "BEGIN CERTIFICATE" in frame.tls_server_cert
    assert frame.tls_server_key and "BEGIN RSA PRIVATE KEY" in frame.tls_server_key
    assert frame.tls_client_ca_cert and "BEGIN CERTIFICATE" in frame.tls_client_ca_cert
    assert frame.tls_server_cert_not_valid_after is not None
    assert frame.tls_client_ca_cert_not_valid_after is not None
    mock_publish.assert_awaited_once()

@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_update_frame(mock_publish, db, redis):
    frame = await new_frame(db, redis, "Frame", "localhost", "server_host", "dev")
    frame.frame_host = "updated_host"
    await update_frame(db, redis, frame)
    updated = db.get(Frame, frame.id)
    assert updated.frame_host == "updated_host"
    # 2 calls to publish_message: "new_frame" & "update_frame"
    assert mock_publish.await_count == 2

@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_delete_frame(mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameToDelete", "localhost", "server_host")
    frame_id = frame.id
    success = await delete_frame(db, redis, frame_id)
    assert success is True
    # After deletion, frame should not be found
    in_db = db.get(Frame, frame_id)
    assert in_db is None
    # 2 calls: "new_frame", "delete_frame"
    assert mock_publish.await_count == 2

@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_delete_nonexistent_frame(mock_publish, db, redis):
    # Attempt to delete an ID that doesn't exist
    success = await delete_frame(db, redis, 999999)
    assert success is False
    # No new frame creation, so no calls before
    # We only get one publish call if you coded publish_message for "delete_frame"
    # but your code might skip if frame not found
    assert mock_publish.await_count == 0

@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_frame_to_dict(mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameDict", "host", "server_host.com", interval=55)
    data = frame.to_dict()
    assert data["frame_host"] == "host"
    assert data["interval"] == 55
    assert data["tls_server_cert_not_valid_after"] is not None
    assert data["tls_client_ca_cert_not_valid_after"] is not None
    # 1 call to publish_message (the new frame creation)
    assert mock_publish.await_count == 1
