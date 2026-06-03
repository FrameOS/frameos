from unittest.mock import patch, AsyncMock

import pytest

from app.models.frame import (
    Frame,
    delete_frame,
    get_frame_json,
    new_frame,
    normalize_error_behavior,
    normalize_frame_admin_auth,
    normalize_reboot_crontab,
    update_frame,
)
from app.models.settings import Settings
from app.schemas.frames import FrameErrorBehavior


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
    assert frame.max_http_response_bytes == 64 * 1024 * 1024
    assert frame.reboot == {"enabled": "true", "crontab": "0 4 * * *"}
    assert frame.server_send_logs is True
    assert frame.https_proxy["enable"] is True
    assert frame.https_proxy["expose_only_port"] is True
    assert frame.https_proxy["certs"]["server"] and "BEGIN CERTIFICATE" in frame.https_proxy["certs"]["server"]
    assert frame.https_proxy["certs"]["server_key"] and "BEGIN RSA PRIVATE KEY" in frame.https_proxy["certs"]["server_key"]
    assert frame.https_proxy["certs"]["client_ca"] and "BEGIN CERTIFICATE" in frame.https_proxy["certs"]["client_ca"]
    assert frame.https_proxy["server_cert_not_valid_after"] is not None
    assert frame.https_proxy["client_ca_cert_not_valid_after"] is not None
    assert frame.mountpoints == {"enabled": False, "items": []}
    assert frame.error_behavior == {
        "mode": "show_error_retry",
        "retry_seconds": 60,
        "silent_retry_seconds": 60,
        "silent_retry_forever": False,
        "silent_window_minutes": 10,
        "show_error_retry_seconds": 60,
    }
    mock_publish.assert_awaited_once()


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_new_frame_sets_known_device_dimensions(_mock_publish, db, redis):
    frame = await new_frame(
        db,
        redis,
        name="InkyFrame",
        frame_host="pi@192.168.1.1",
        server_host="server_host.com",
        device="pimoroni.inky_what_yellow",
    )

    assert frame.width == 400
    assert frame.height == 300


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
    await redis.set(f"frame:{frame_id}:image", b"cached_image")
    success = await delete_frame(db, redis, frame_id, frame.project_id)
    assert success is True
    # After deletion, frame should not be found
    in_db = db.get(Frame, frame_id)
    assert in_db is None
    assert await redis.get(f"frame:{frame_id}:image") is None
    # 2 calls: "new_frame", "delete_frame"
    assert mock_publish.await_count == 2


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_delete_nonexistent_frame(mock_publish, db, redis):
    success = await delete_frame(db, redis, 999999, 1)
    assert success is False
    assert mock_publish.await_count == 0


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_frame_to_dict(mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameDict", "host", "server_host.com", interval=55)
    data = frame.to_dict()
    assert data["frame_host"] == "host"
    assert data["interval"] == 55
    assert data["max_http_response_bytes"] == 64 * 1024 * 1024
    assert data["server_send_logs"] is True
    assert data["reboot"]["crontab"] == "0 4 * * *"
    assert data["https_proxy"]["certs"]["server"]
    assert data["https_proxy"]["certs"]["server_key"]
    assert data["https_proxy"]["certs"]["client_ca"]
    assert data["https_proxy"]["server_cert_not_valid_after"] is not None
    assert data["https_proxy"]["client_ca_cert_not_valid_after"] is not None
    assert data["mountpoints"] == {"enabled": False, "items": []}
    assert data["error_behavior"]["mode"] == "show_error_retry"
    assert mock_publish.await_count == 1


def test_normalize_error_behavior_defaults_and_sanitizes_values():
    assert normalize_error_behavior(None) == {
        "mode": "show_error_retry",
        "retry_seconds": 60,
        "silent_retry_seconds": 60,
        "silent_retry_forever": False,
        "silent_window_minutes": 10,
        "show_error_retry_seconds": 60,
    }

    assert normalize_error_behavior({
        "mode": "silent_retry",
        "retry_seconds": "0",
        "silent_retry_seconds": "5",
        "silent_retry_forever": True,
        "silent_window_minutes": -1,
        "show_error_retry_seconds": "120",
    }) == {
        "mode": "silent_retry",
        "retry_seconds": 60,
        "silent_retry_seconds": 5,
        "silent_retry_forever": True,
        "silent_window_minutes": 10,
        "show_error_retry_seconds": 120,
    }

    assert normalize_error_behavior({
        "mode": "silent_retry",
        "silent_retry_minutes": 7,
    })["silent_window_minutes"] == 7

    assert FrameErrorBehavior.model_validate({
        "mode": "silent_retry",
        "silent_retry_minutes": 8,
    }).silent_window_minutes == 8


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_includes_error_behavior(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    frame.error_behavior = {
        "mode": "silent_retry",
        "retry_seconds": 15,
        "silent_retry_seconds": 20,
        "silent_retry_forever": False,
        "silent_window_minutes": 3,
        "show_error_retry_seconds": 90,
    }

    data = get_frame_json(db, frame)

    assert data["errorBehavior"] == {
        "mode": "silent_retry",
        "retrySeconds": 15,
        "silentRetrySeconds": 20,
        "silentRetryForever": False,
        "silentWindowMinutes": 3,
        "showErrorRetrySeconds": 90,
    }


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_includes_image_engine(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    data = get_frame_json(db, frame)
    assert data["imageEngine"] == ""

    frame.image_engine = "imagemagick"
    data = get_frame_json(db, frame)
    assert data["imageEngine"] == "imagemagick"


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_includes_max_http_response_bytes(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    frame.max_http_response_bytes = 32 * 1024 * 1024

    data = get_frame_json(db, frame)

    assert data["maxHttpResponseBytes"] == 32 * 1024 * 1024


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_uses_known_device_dimensions_when_unset(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com", "pimoroni.inky_what_yellow")
    frame.width = None
    frame.height = None

    data = get_frame_json(db, frame)

    assert data["width"] == 400
    assert data["height"] == 300


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_uses_frame_timezone_or_global_default(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    db.add(Settings(project_id=frame.project_id, key="defaults", value={"timezone": "Europe/Brussels"}))
    db.commit()
    frame.mode = "buildroot"
    frame.timezone = None

    data = get_frame_json(db, frame)

    assert data["timeZone"] == "Europe/Brussels"

    frame.timezone = "America/New_York"
    data = get_frame_json(db, frame)

    assert data["timeZone"] == "America/New_York"


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_uses_explicit_timezone_for_rpios(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    db.add(Settings(project_id=frame.project_id, key="defaults", value={"timezone": "Europe/Brussels"}))
    db.commit()
    frame.mode = "rpios"
    frame.timezone = "America/New_York"

    data = get_frame_json(db, frame)

    assert data["timeZone"] == "America/New_York"


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_does_not_default_timezone_for_rpios(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    db.add(Settings(project_id=frame.project_id, key="defaults", value={"timezone": "Europe/Brussels"}))
    db.commit()
    frame.mode = "rpios"
    frame.timezone = None

    data = get_frame_json(db, frame)

    assert "timeZone" not in data


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_preserves_unknown_explicit_timezone_for_rpios(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    frame.mode = "rpios"
    frame.timezone = "Custom/Zone"

    data = get_frame_json(db, frame)

    assert data["timeZone"] == "Custom/Zone"


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_get_frame_json_includes_timezone_update_settings(_mock_publish, db, redis):
    frame = await new_frame(db, redis, "FrameJson", "host", "server_host.com")
    db.commit()
    frame.timezone_settings = {
        "enabled": False,
        "hour": 5,
        "url": "https://example.com/tzdata.json.gz",
    }

    data = get_frame_json(db, frame)

    assert data["timeZoneUpdates"] == {
        "enabled": False,
        "hour": 5,
        "url": "https://example.com/tzdata.json.gz",
    }


def test_normalize_frame_admin_auth_keeps_password_whitespace():
    assert normalize_frame_admin_auth(
        {
            "enabled": True,
            "user": " admin ",
            "pass": " secret ",
        }
    ) == {
        "enabled": True,
        "user": "admin",
        "pass": " secret ",
    }


def test_normalize_reboot_crontab_fixes_legacy_hour_minute_swap():
    assert normalize_reboot_crontab("4 0 * * *") == "0 4 * * *"
    assert normalize_reboot_crontab("23 0 * * *") == "0 23 * * *"
    assert normalize_reboot_crontab("0 4 * * *") == "0 4 * * *"
    assert normalize_reboot_crontab("*/15 * * * *") == "*/15 * * * *"
