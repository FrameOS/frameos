import hashlib
from unittest.mock import AsyncMock, patch

import pytest

from app.models import new_frame


@pytest.mark.asyncio
async def test_api_frame_event_upload_scene_valid(async_client, db, redis):
    frame = await new_frame(db, redis, "SceneEventFrame", "localhost", "localhost")
    payload = {"scene": {"id": "scene-a", "nodes": []}}

    with patch(
        "app.api.frames._forward_frame_request",
        new=AsyncMock(return_value="OK"),
    ) as forward_request:
        response = await async_client.post(
            f"/api/frames/{frame.id}/event/uploadScene",
            json=payload,
        )

    assert response.status_code == 200
    assert response.json() == "OK"
    forward_request.assert_awaited_once()
    _, kwargs = forward_request.call_args
    assert kwargs["path"] == "/event/uploadScene"
    assert kwargs["json_body"] == payload


@pytest.mark.asyncio
async def test_api_frame_event_upload_scene_invalid_reference(async_client, db, redis):
    frame = await new_frame(db, redis, "SceneEventInvalid", "localhost", "localhost")
    payload = {
        "scenes": [
            {
                "id": "scene-a",
                "nodes": [
                    {"type": "scene", "data": {"keyword": "missing-scene"}},
                ],
            }
        ]
    }

    response = await async_client.post(
        f"/api/frames/{frame.id}/event/uploadScene",
        json=payload,
    )

    assert response.status_code == 400
    assert "references missing scene" in response.json()["detail"]


@pytest.mark.asyncio
async def test_api_frame_upload_scenes_forwards_payload(async_client, db, redis):
    frame = await new_frame(db, redis, "UploadScenesFrame", "localhost", "localhost")
    payload = {
        "scenes": [{"id": "scene-a", "nodes": []}],
        "sceneId": "scene-a",
    }

    with patch(
        "app.api.frames._forward_frame_request",
        new=AsyncMock(return_value="OK"),
    ) as forward_request:
        response = await async_client.post(
            f"/api/frames/{frame.id}/upload_scenes",
            json=payload,
        )

    assert response.status_code == 200
    assert response.json() == "OK"
    forward_request.assert_awaited_once()
    _, kwargs = forward_request.call_args
    assert kwargs["path"] == "/uploadScenes"
    assert kwargs["json_body"] == payload


@pytest.mark.asyncio
async def test_api_frame_assets_upload_image_uploads_new_file(async_client, db, redis):
    frame = await new_frame(db, redis, "UploadImageFrame", "localhost", "localhost")
    data = b"fake-image-data"
    md5sum = hashlib.md5(data).hexdigest()
    expected_filename = f"My_File.{md5sum}.png"
    expected_path = f"/srv/assets/uploads/{expected_filename}"

    with patch("app.api.frames.make_dir", new=AsyncMock()) as make_dir, patch(
        "app.api.frames.run_command",
        new=AsyncMock(return_value=(1, "", "")),
    ) as run_command, patch(
        "app.api.frames.upload_file",
        new=AsyncMock(),
    ) as upload_file:
        response = await async_client.post(
            f"/api/frames/{frame.id}/assets/upload_image",
            files={"file": ("My File.png", data, "image/png")},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["filename"] == expected_filename
    assert payload["path"] == f"uploads/{expected_filename}"
    assert payload["size"] == len(data)
    assert payload["uploaded"] is True
    make_dir.assert_awaited_once()
    run_command.assert_awaited_once()
    upload_file.assert_awaited_once()
    await_args = upload_file.await_args
    assert await_args is not None
    assert await_args.args[3] == expected_path
    assert await_args.args[4] == data


@pytest.mark.asyncio
async def test_api_frame_assets_upload_image_skips_existing(async_client, db, redis):
    frame = await new_frame(db, redis, "UploadImageExists", "localhost", "localhost")
    data = b"fake-image-data"

    with patch("app.api.frames.make_dir", new=AsyncMock()), patch(
        "app.api.frames.run_command",
        new=AsyncMock(return_value=(0, "", "")),
    ), patch(
        "app.api.frames.upload_file",
        new=AsyncMock(),
    ) as upload_file:
        response = await async_client.post(
            f"/api/frames/{frame.id}/assets/upload_image",
            files={"file": ("My File.png", data, "image/png")},
        )

    assert response.status_code == 200
    assert response.json()["uploaded"] is False
    upload_file.assert_not_awaited()
