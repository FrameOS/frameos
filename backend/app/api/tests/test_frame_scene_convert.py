from unittest.mock import patch

import httpx
import pytest

from app.models.frame import new_frame, update_frame


@pytest.mark.asyncio
async def test_convert_forwards_the_stored_scene_and_returns_the_cloud_reply(async_client, db, redis):
    frame = await new_frame(db, redis, "Conv", "example.com", "localhost")
    nim = {"id": "s1", "name": "Old", "nodes": [{"id": "c1", "type": "code", "data": {"code": "1 + 1"}}]}
    frame.scenes = [nim]
    await update_frame(db, redis, frame)
    seen = {}

    async def fake_post(url, payload):
        seen["url"] = url
        seen["json"] = payload
        return 200, {"ok": True, "scene": {**nim, "settings": {"execution": "interpreted"}}, "reports": []}

    with patch("app.api.frames._post_to_converter", fake_post):
        response = await async_client.post(f"/api/frames/{frame.id}/scenes/s1/convert")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert seen["url"].endswith("/api/scenes/convert")
    assert seen["json"]["scene"]["id"] == "s1"
    # No key configured: the cloud's shared budget pays.
    assert "openaiApiKey" not in seen["json"]


@pytest.mark.asyncio
async def test_convert_prefers_the_editors_unsaved_copy_and_passes_errors_through(async_client, db, redis):
    frame = await new_frame(db, redis, "Conv2", "example.com", "localhost")
    frame.scenes = [{"id": "s1", "nodes": []}]
    await update_frame(db, redis, frame)
    seen = {}

    async def fake_post(url, payload):
        seen["json"] = payload
        return 429, {"error": "model_budget_exhausted", "retry_after": 60}

    with patch("app.api.frames._post_to_converter", fake_post):
        response = await async_client.post(
            f"/api/frames/{frame.id}/scenes/s1/convert",
            json={"scene": {"id": "s1", "name": "edited", "nodes": [{"id": "x", "type": "code", "data": {"code": "2"}}]}},
        )
    assert response.status_code == 429
    assert response.json()["error"] == "model_budget_exhausted"
    assert seen["json"]["scene"]["name"] == "edited"


@pytest.mark.asyncio
async def test_convert_unknown_scene_is_404_and_unreachable_cloud_is_502(async_client, db, redis):
    frame = await new_frame(db, redis, "Conv3", "example.com", "localhost")
    response = await async_client.post(f"/api/frames/{frame.id}/scenes/nope/convert")
    assert response.status_code == 404

    frame.scenes = [{"id": "s1", "nodes": []}]
    await update_frame(db, redis, frame)

    async def down(url, payload):
        raise httpx.ConnectError("boom")

    with patch("app.api.frames._post_to_converter", down):
        response = await async_client.post(f"/api/frames/{frame.id}/scenes/s1/convert")
    assert response.status_code == 502
