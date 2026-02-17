import pytest
from unittest.mock import patch, AsyncMock
from app.models.frame import Frame, delete_frame, new_frame, normalize_https_proxy, update_frame


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
        interval=123,
    )
    assert frame.id is not None
    assert frame.name == "TestFrame"
    assert frame.frame_host == "192.168.1.1"
    assert frame.frame_port == 8787
    assert frame.ssh_user == "pi"
    assert frame.device == "testDevice"
    assert frame.interval == 123
    assert frame.https_proxy["enable"] is True
    assert frame.https_proxy["expose_only_port"] is True
    assert frame.https_proxy["certs"]["server"] and "BEGIN CERTIFICATE" in frame.https_proxy["certs"]["server"]
    assert frame.https_proxy["certs"]["server_key"] and "BEGIN RSA PRIVATE KEY" in frame.https_proxy["certs"]["server_key"]
    assert frame.https_proxy["certs"]["client_ca"] and "BEGIN CERTIFICATE" in frame.https_proxy["certs"]["client_ca"]
    assert frame.https_proxy["server_cert_not_valid_after"] is not None
    assert frame.https_proxy["client_ca_cert_not_valid_after"] is not None
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
    success = await delete_frame(db, redis, 999999)
    assert success is False
    assert mock_publish.await_count == 0


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_frame_to_dict(mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameDict", "host", "server_host.com", interval=55)
    data = frame.to_dict()
    assert data["frame_host"] == "host"
    assert data["interval"] == 55
    assert data["https_proxy"]["certs"]["server"]
    assert data["https_proxy"]["certs"]["server_key"]
    assert data["https_proxy"]["certs"]["client_ca"]
    assert data["https_proxy"]["server_cert_not_valid_after"] is not None
    assert data["https_proxy"]["client_ca_cert_not_valid_after"] is not None
    assert mock_publish.await_count == 1


def test_normalize_https_proxy_migrates_legacy_fields():
    normalized = normalize_https_proxy({
        "enable": True,
        "server_cert": "legacy-server",
        "server_key": "legacy-key",
        "client_ca_cert": "legacy-ca",
    })

    assert normalized["certs"]["server"] == "legacy-server"
    assert normalized["certs"]["server_key"] == "legacy-key"
    assert normalized["certs"]["client_ca"] == "legacy-ca"
    assert "server_cert" not in normalized
    assert "server_key" not in normalized
    assert "client_ca_cert" not in normalized
