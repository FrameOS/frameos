"""Asset management for embedded (ESP32) frames: the backend proxies every
asset route to the device's HTTP API instead of SSH/agent. The device layer
(`_fetch_frame_http_bytes`) is mocked; these tests pin the proxy contract:
paths relative on the wire, absolute in backend responses."""

import io
import json
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, quote

import pytest
from PIL import Image

from app.api import frames as frames_api
from app.models.frame import Frame

FETCH = "app.utils.embedded_assets._fetch_frame_http_bytes"


async def create_embedded_frame(async_client, db) -> Frame:
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Assets Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
    })
    assert response.status_code == 200, response.text
    frame = db.get(Frame, response.json()['frame']['id'])
    assert frame is not None
    return frame


class FakeDevice:
    """Collects calls and replays canned (status, body, headers) responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def __call__(self, frame, redis, *, path, method="GET", body=None, headers=None, timeout=None):
        self.calls.append({"path": path, "method": method, "body": body, "headers": headers})
        if not self.responses:
            raise AssertionError(f"Unexpected device request: {method} {path}")
        return self.responses.pop(0)


def json_response(payload, status=200):
    return status, json.dumps(payload).encode(), {"content-type": "application/json"}


# ---------------------------------------------------------------------------
# listing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_assets_returns_absolute_sorted_paths(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([
        json_response({
            "assets": [
                {"path": "zebra.jpg", "size": 10, "mtime": 200, "is_dir": False},
                {"path": "sub", "size": 0, "mtime": 100, "is_dir": True},
                {"path": "sub/file.jpg", "size": 123, "mtime": 1712345678, "is_dir": False},
            ],
            "mounted": True,
        })
    ])

    with patch(FETCH, new=device):
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["assets"] == [
        {"path": "/srv/assets/sub", "size": 0, "mtime": 100, "is_dir": True},
        {"path": "/srv/assets/sub/file.jpg", "size": 123, "mtime": 1712345678, "is_dir": False},
        {"path": "/srv/assets/zebra.jpg", "size": 10, "mtime": 200, "is_dir": False},
    ]
    assert payload["cache"]["cached"] is False
    assert device.calls == [{
        "path": f"/api/frames/{frame.id}/assets",
        "method": "GET",
        "body": None,
        "headers": None,
    }]


@pytest.mark.asyncio
async def test_list_assets_unmounted_sd_card_reports_storage_state(async_client, db, redis):
    """An unmounted card must never read as "the card is empty": the panel
    needs the flag to say so, and the empty listing must not be cached."""
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"assets": [], "mounted": False})])
    cache_key = frames_api._frame_assets_cache_key(frame.id, "/srv/assets")

    with patch(FETCH, new=device):
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["assets"] == []
    assert payload["storage"] == {"mounted": False}
    # Nothing cached: 30 days of "no assets" is the bug this fixes.
    assert await redis.get(cache_key) is None


@pytest.mark.asyncio
async def test_unmounted_listing_does_not_replace_a_good_cached_listing(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    cache_key = frames_api._frame_assets_cache_key(frame.id, "/srv/assets")
    await frames_api._write_frame_assets_cache(
        redis,
        cache_key,
        [{"path": "/srv/assets/photo.jpg", "size": 10, "mtime": 1, "is_dir": False}],
    )
    device = FakeDevice([json_response({"assets": [], "mounted": False})])

    with patch(FETCH, new=device):
        response = await async_client.get(f'/api/frames/{frame.id}/assets?refresh=1')

    assert response.status_code == 200, response.text
    assert response.json()["storage"] == {"mounted": False}
    assert await redis.get(cache_key) is None


@pytest.mark.asyncio
async def test_list_assets_returning_card_shows_files_on_the_next_request(async_client, db, redis):
    """A card that comes back must show up immediately, not once the 30-day
    cache TTL expires."""
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([
        json_response({"assets": [], "mounted": False}),
        json_response({
            "assets": [{"path": "photo.jpg", "size": 10, "mtime": 200, "is_dir": False}],
            "mounted": True,
        }),
    ])

    with patch(FETCH, new=device):
        while_unmounted = await async_client.get(f'/api/frames/{frame.id}/assets')
        after_reinsert = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert while_unmounted.json()["assets"] == []
    assert while_unmounted.json()["storage"] == {"mounted": False}
    assert len(device.calls) == 2  # the device is re-asked, not served from cache
    payload = after_reinsert.json()
    assert payload["assets"] == [
        {"path": "/srv/assets/photo.jpg", "size": 10, "mtime": 200, "is_dir": False},
    ]
    assert payload["storage"] == {"mounted": True}


@pytest.mark.asyncio
async def test_list_assets_mounted_card_is_cached_with_storage_state(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([
        json_response({
            "assets": [{"path": "a.txt", "size": 1, "mtime": 1, "is_dir": False}],
            "mounted": True,
        })
    ])

    with patch(FETCH, new=device):
        first = await async_client.get(f'/api/frames/{frame.id}/assets')
        second = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert first.json()["storage"] == {"mounted": True}
    assert second.json()["cache"]["cached"] is True
    assert second.json()["storage"] == {"mounted": True}
    assert len(device.calls) == 1


@pytest.mark.asyncio
async def test_list_assets_without_mounted_flag_keeps_old_behaviour(async_client, db, redis):
    """Older firmware (and every non-SD frame) says nothing about mounting —
    those must never be warned about, and must stay cached as before."""
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([
        json_response({"assets": [{"path": "a.txt", "size": 1, "mtime": 1, "is_dir": False}]})
    ])

    with patch(FETCH, new=device):
        first = await async_client.get(f'/api/frames/{frame.id}/assets')
        second = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert first.json()["storage"] is None
    assert first.json()["assets"] == [
        {"path": "/srv/assets/a.txt", "size": 1, "mtime": 1, "is_dir": False},
    ]
    assert second.json()["cache"]["cached"] is True
    assert second.json()["storage"] is None
    assert len(device.calls) == 1


@pytest.mark.asyncio
async def test_empty_mounted_card_is_cached_as_empty(async_client, db, redis):
    """A genuinely empty card is still an empty listing: no warning, and the
    cache keeps working."""
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"assets": [], "mounted": True})])
    cache_key = frames_api._frame_assets_cache_key(frame.id, "/srv/assets")

    with patch(FETCH, new=device):
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.json()["assets"] == []
    assert response.json()["storage"] == {"mounted": True}
    assert await redis.get(cache_key) is not None


@pytest.mark.asyncio
async def test_list_assets_uses_cache_without_calling_device(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([
        json_response({"assets": [{"path": "a.txt", "size": 1, "mtime": 1, "is_dir": False}], "mounted": True})
    ])

    with patch(FETCH, new=device):
        first = await async_client.get(f'/api/frames/{frame.id}/assets')
        second = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["assets"] == first.json()["assets"]
    assert second.json()["cache"]["cached"] is True
    assert len(device.calls) == 1  # second request served from the redis cache


@pytest.mark.asyncio
async def test_list_assets_device_error_maps_to_bad_gateway(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([(500, b"sd card error", {})])

    with patch(FETCH, new=device):
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.status_code == 502
    assert "sd card error" in response.json()["detail"]


# ---------------------------------------------------------------------------
# upload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_sends_raw_bytes_to_device(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    data = b"file-bytes"
    device = FakeDevice([
        json_response({"path": "sub/pic.png", "size": len(data), "mtime": 1712345678, "is_dir": False})
    ])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/upload',
            data={"path": "sub"},
            files={"file": ("pic.png", data, "image/png")},
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["path"] == "sub/pic.png"
    assert payload["size"] == len(data)
    assert payload["is_dir"] is False

    call = device.calls[0]
    assert call["method"] == "POST"
    assert call["path"] == f"/api/frames/{frame.id}/assets/upload?path={quote('sub/pic.png', safe='')}"
    assert call["body"] == data
    assert call["headers"]["Content-Type"] == "application/octet-stream"


@pytest.mark.asyncio
async def test_upload_image_uploads_and_reports_path(async_client, db, redis):
    import hashlib

    frame = await create_embedded_frame(async_client, db)
    data = b"fake-image-bytes"
    md5sum = hashlib.md5(data).hexdigest()
    expected_rel = f"uploads/My_File.{md5sum}.png"
    device = FakeDevice([
        json_response({"path": expected_rel, "size": len(data), "mtime": 1, "is_dir": False})
    ])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/upload_image',
            files={"file": ("My File.png", data, "image/png")},
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["path"] == expected_rel
    assert payload["uploaded"] is True
    assert payload["size"] == len(data)

    call = device.calls[0]
    assert call["method"] == "POST"
    assert call["path"] == f"/api/frames/{frame.id}/assets/upload?path={quote(expected_rel, safe='')}"
    assert call["body"] == data


@pytest.mark.asyncio
async def test_upload_rejects_path_traversal(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/upload',
            data={"path": "../outside"},
            files={"file": ("x.txt", b"x", "text/plain")},
        )

    assert response.status_code == 400
    assert device.calls == []


# ---------------------------------------------------------------------------
# mkdir / delete / rename
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mkdir_posts_form_encoded_relative_path(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"ok": True})])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/mkdir',
            data={"path": "new/folder"},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"message": "Created"}
    call = device.calls[0]
    assert call["method"] == "POST"
    assert call["path"] == f"/api/frames/{frame.id}/assets/mkdir"
    assert parse_qs(call["body"]) == {"path": ["new/folder"]}
    assert call["headers"]["Content-Type"] == "application/x-www-form-urlencoded"


@pytest.mark.asyncio
async def test_delete_posts_form_encoded_relative_path(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"ok": True})])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/delete',
            data={"path": "sub/file.jpg"},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"message": "Deleted"}
    call = device.calls[0]
    assert call["path"] == f"/api/frames/{frame.id}/assets/delete"
    assert parse_qs(call["body"]) == {"path": ["sub/file.jpg"]}


@pytest.mark.asyncio
async def test_rename_posts_src_and_dst(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"ok": True})])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/rename',
            data={"src": "old.txt", "dst": "sub/new.txt"},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"message": "Renamed"}
    call = device.calls[0]
    assert call["path"] == f"/api/frames/{frame.id}/assets/rename"
    assert parse_qs(call["body"]) == {"src": ["old.txt"], "dst": ["sub/new.txt"]}


@pytest.mark.asyncio
async def test_delete_maps_device_404(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([(404, b"no such file", {})])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/delete',
            data={"path": "missing.txt"},
        )

    assert response.status_code == 404
    assert "no such file" in response.json()["detail"]


# ---------------------------------------------------------------------------
# single-file GET (download / inline / thumb)
# ---------------------------------------------------------------------------


def asset_url(async_client, frame, query: str) -> str:
    return f"/api/projects/{async_client.project_id}/frames/{frame.id}/asset?{query}"


@pytest.mark.asyncio
async def test_get_asset_downloads_original_bytes(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    data = b"hello embedded world"
    device = FakeDevice([(200, data, {"content-type": "text/plain"})])

    with patch(FETCH, new=device):
        response = await async_client.get(asset_url(async_client, frame, "path=sub/hello.txt"))

    assert response.status_code == 200, response.text
    assert response.content == data
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert "attachment" in response.headers["content-disposition"]
    assert 'filename="hello.txt"' in response.headers["content-disposition"]

    call = device.calls[0]
    assert call["method"] == "GET"
    assert call["path"] == f"/api/frames/{frame.id}/asset?path={quote('sub/hello.txt', safe='')}"

    # Mirrors the agent code path: original bytes cached by md5.
    import hashlib
    cached = await redis.get(f"asset:{hashlib.md5(data).hexdigest()}")
    assert cached == data


@pytest.mark.asyncio
async def test_get_asset_image_mode_inline_disposition(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([(200, b"png-bytes", {"content-type": "image/png"})])

    with patch(FETCH, new=device):
        response = await async_client.get(
            asset_url(async_client, frame, "path=pic.png&mode=image")
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.headers["content-disposition"].startswith("inline")


@pytest.mark.asyncio
async def test_get_asset_missing_maps_to_404(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([(404, b"not found", {})])

    with patch(FETCH, new=device):
        response = await async_client.get(asset_url(async_client, frame, "path=missing.txt"))

    assert response.status_code == 404
    assert response.json()["detail"] == "Asset not found"


@pytest.mark.asyncio
async def test_get_asset_rejects_path_traversal(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([])

    with patch(FETCH, new=device):
        response = await async_client.get(
            asset_url(async_client, frame, "path=" + quote("../../etc/passwd", safe=""))
        )

    assert response.status_code == 400
    assert device.calls == []


@pytest.mark.asyncio
async def test_get_asset_thumb_generates_and_caches_jpeg(async_client, db, redis):
    import hashlib

    frame = await create_embedded_frame(async_client, db)
    png = io.BytesIO()
    Image.new("RGB", (640, 480), "red").save(png, format="PNG")
    original = png.getvalue()
    device = FakeDevice([
        (200, original, {"content-type": "image/png"}),
        (200, original, {"content-type": "image/png"}),
    ])

    with patch(FETCH, new=device):
        response = await async_client.get(
            asset_url(async_client, frame, "path=photo.png&thumb=1")
        )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("image/jpeg")
    with Image.open(io.BytesIO(response.content)) as thumbnail:
        assert thumbnail.format == "JPEG"
        assert max(thumbnail.size) <= 320

    cache_key = f"asset:thumb:{hashlib.md5(original).hexdigest()}"
    cached = await redis.get(cache_key)
    assert cached == response.content

    # Second request re-fetches the original (for the md5) but reuses the
    # cached thumbnail instead of re-encoding.
    with patch(FETCH, new=device), patch(
        "app.utils.embedded_assets.thumbnail_jpeg"
    ) as thumbnailer:
        again = await async_client.get(
            asset_url(async_client, frame, "path=photo.png&thumb=1")
        )
    assert again.status_code == 200
    assert again.content == response.content
    thumbnailer.assert_not_called()


@pytest.mark.asyncio
async def test_get_asset_thumb_rejects_non_image_extension(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([])

    with patch(FETCH, new=device):
        response = await async_client.get(
            asset_url(async_client, frame, "path=notes.txt&thumb=1")
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Not an image"
    assert device.calls == []


@pytest.mark.asyncio
async def test_get_asset_thumb_falls_back_to_original_on_undecodable_image(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    broken = b"not really a png"
    device = FakeDevice([(200, broken, {"content-type": "image/png"})])

    with patch(FETCH, new=device):
        response = await async_client.get(
            asset_url(async_client, frame, "path=broken.png&thumb=1")
        )

    assert response.status_code == 200
    assert response.content == broken


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assets_sync_refused_without_an_sd_card(async_client, db, redis):
    # A board with no card has no filesystem at all. Saying so beats claiming
    # the fonts went somewhere.
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"assets": [], "mounted": False})])

    with patch(FETCH, new=device):
        with patch("app.models.assets.sync_embedded_font_assets", new=AsyncMock()) as sync:
            response = await async_client.post(f'/api/frames/{frame.id}/assets/sync')

    assert response.status_code == 400
    assert "No SD card" in response.json()["detail"]
    sync.assert_not_awaited()


@pytest.mark.asyncio
async def test_assets_sync_uploads_fonts_to_the_sd_card(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([json_response({"assets": [], "mounted": True})])
    uploaded: list[tuple[str, int]] = []

    async def fake_upload(frame_arg, redis_arg, full_path, data):
        uploaded.append((full_path, len(data)))
        return {}

    with patch(FETCH, new=device):
        with patch("app.utils.embedded_assets.upload_asset", new=fake_upload):
            response = await async_client.post(f'/api/frames/{frame.id}/assets/sync')

    assert response.status_code == 200, response.text
    assert response.json()["uploaded"] == len(uploaded)
    assert uploaded, "the bundled fonts should have been pushed to an empty card"
    # Straight into the fonts directory the device's /api/fonts route reads,
    # and the renderer loads from.
    assert all(path.startswith("/srv/assets/fonts/") for path, _ in uploaded)
    assert all(path.endswith(".ttf") for path, _ in uploaded)


@pytest.mark.asyncio
async def test_assets_sync_skips_fonts_the_card_already_has(async_client, db, redis):
    from app.models.assets import _fonts_to_sync

    frame = await create_embedded_frame(async_client, db)
    # Device-relative paths, exactly as the firmware reports them.
    existing = [
        {
            "path": f"fonts/{name}",
            "size": len(data),
            "mtime": 0,
            "is_dir": False,
        }
        for name, data in _fonts_to_sync(db, frame)
    ]
    device = FakeDevice([json_response({"assets": existing, "mounted": True})])
    uploaded: list[str] = []

    async def fake_upload(frame_arg, redis_arg, full_path, data):
        uploaded.append(full_path)
        return {}

    with patch(FETCH, new=device):
        with patch("app.utils.embedded_assets.upload_asset", new=fake_upload):
            response = await async_client.post(f'/api/frames/{frame.id}/assets/sync')

    assert response.status_code == 200, response.text
    assert response.json()["uploaded"] == 0
    assert uploaded == []


@pytest.mark.asyncio
async def test_assets_sync_refused_for_virtual_frames(async_client, db, redis):
    # Virtual frames render in the browser out of the wasm bundle's own fonts.
    response = await async_client.post('/api/frames/new', json={
        'name': 'Virtual Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'virtual',
    })
    assert response.status_code == 200, response.text
    frame_id = response.json()['frame']['id']

    with patch("app.models.assets.sync_assets", new=AsyncMock()) as sync_assets:
        response = await async_client.post(f'/api/frames/{frame_id}/assets/sync')

    assert response.status_code == 400
    assert "not supported for virtual frames" in response.json()["detail"]
    sync_assets.assert_not_awaited()


# ---------------------------------------------------------------------------
# cache invalidation on writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_operations_invalidate_assets_cache(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    cache_key = frames_api._frame_assets_cache_key(frame.id, "/srv/assets")
    await frames_api._write_frame_assets_cache(redis, cache_key, [])
    assert await redis.get(cache_key) is not None

    device = FakeDevice([json_response({"ok": True})])
    with patch(FETCH, new=device):
        response = await async_client.post(
            f'/api/frames/{frame.id}/assets/mkdir',
            data={"path": "folder"},
        )

    assert response.status_code == 200
    assert await redis.get(cache_key) is None


# ---------------------------------------------------------------------------
# chunked upload
# ---------------------------------------------------------------------------


def _chunk_url(frame_id, upload_id, filename, chunk_index, offset, complete, path=""):
    from urllib.parse import urlencode

    params = {
        "upload_id": upload_id,
        "filename": filename,
        "chunk_index": chunk_index,
        "offset": offset,
        "complete": "1" if complete else "0",
    }
    if path:
        params["path"] = path
    return f"/api/frames/{frame_id}/assets/upload?{urlencode(params)}"


def _device_query(call):
    from urllib.parse import urlsplit

    split = urlsplit(call["path"])
    return {k: v[0] for k, v in parse_qs(split.query).items()}


@pytest.mark.asyncio
async def test_chunked_upload_forwards_each_chunk_to_device(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    chunks = [b"aaaa", b"bbbb", b"cc"]
    device = FakeDevice([
        json_response({"pending": True, "received": 4}),
        json_response({"pending": True, "received": 8}),
        json_response({"path": "sub/big.bin", "size": 10, "mtime": 1712345678, "is_dir": False}),
    ])

    with patch(FETCH, new=device):
        for index, chunk in enumerate(chunks):
            response = await async_client.post(
                _chunk_url(frame.id, "chunky1", "big.bin", index, index * 4,
                           index == len(chunks) - 1, path="sub"),
                content=chunk,
                headers={"Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 200, response.text
            if index < len(chunks) - 1:
                assert response.json() == {"pending": True, "received": (index + 1) * 4}

    final = response.json()
    assert final["path"] == "sub/big.bin"
    assert final["size"] == 10
    assert final["is_dir"] is False

    assert [call["body"] for call in device.calls] == chunks
    queries = [_device_query(call) for call in device.calls]
    assert [q["offset"] for q in queries] == ["0", "4", "8"]
    assert [q["complete"] for q in queries] == ["0", "0", "1"]
    assert all(q["upload_id"] == "chunky1" for q in queries)
    assert all(q["path"] == "sub/big.bin" for q in queries)


@pytest.mark.asyncio
async def test_chunked_upload_legacy_firmware_accumulates_and_sends_whole_file(
    async_client, db, redis
):
    frame = await create_embedded_frame(async_client, db)
    chunks = [b"aaaa", b"bbbb", b"cc"]
    device = FakeDevice([
        # Legacy firmware ignores chunk params: replies with a stat dict (no
        # "pending") for the probe chunk...
        json_response({"path": "big.bin", "size": 4, "mtime": 1, "is_dir": False}),
        # ...and receives one whole-file upload at the end.
        json_response({"path": "big.bin", "size": 10, "mtime": 2, "is_dir": False}),
    ])

    with patch(FETCH, new=device):
        for index, chunk in enumerate(chunks):
            response = await async_client.post(
                _chunk_url(frame.id, "legacy1", "big.bin", index, index * 4,
                           index == len(chunks) - 1),
                content=chunk,
                headers={"Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 200, response.text

    final = response.json()
    assert final["path"] == "big.bin"
    assert final["size"] == 10

    assert len(device.calls) == 2
    assert device.calls[0]["body"] == b"aaaa"          # the chunked probe
    assert "upload_id" in _device_query(device.calls[0])
    assert device.calls[1]["body"] == b"aaaabbbbcc"    # the whole file
    assert "upload_id" not in _device_query(device.calls[1])


@pytest.mark.asyncio
async def test_chunked_upload_device_gap_maps_to_conflict(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([(409, b'{"error":"chunk_gap"}', {})])

    with patch(FETCH, new=device):
        response = await async_client.post(
            _chunk_url(frame.id, "gappy1", "big.bin", 3, 12, False),
            content=b"dddd",
            headers={"Content-Type": "application/octet-stream"},
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_chunked_upload_rejects_bad_upload_id(async_client, db, redis):
    frame = await create_embedded_frame(async_client, db)
    device = FakeDevice([])

    with patch(FETCH, new=device):
        response = await async_client.post(
            f"/api/frames/{frame.id}/assets/upload?upload_id=..%2Fevil&filename=x.bin",
            content=b"x",
            headers={"Content-Type": "application/octet-stream"},
        )

    assert response.status_code == 400
    assert device.calls == []


@pytest.mark.asyncio
async def test_upload_asset_splits_large_payload_into_chunks(async_client, db, redis, monkeypatch):
    from app.utils import embedded_assets

    frame = await create_embedded_frame(async_client, db)
    monkeypatch.setattr(embedded_assets, "EMBEDDED_UPLOAD_CHUNK_BYTES", 4)
    data = b"aaaabbbbcc"
    device = FakeDevice([
        json_response({"pending": True, "received": 4}),
        json_response({"pending": True, "received": 8}),
        json_response({"path": "big.bin", "size": 10, "mtime": 1, "is_dir": False}),
    ])

    with patch(FETCH, new=device):
        payload = await embedded_assets.upload_asset(frame, redis, "/srv/assets/big.bin", data)

    assert payload["size"] == 10
    assert [call["body"] for call in device.calls] == [b"aaaa", b"bbbb", b"cc"]
    queries = [_device_query(call) for call in device.calls]
    assert [q["offset"] for q in queries] == ["0", "4", "8"]
    assert [q["complete"] for q in queries] == ["0", "0", "1"]
    assert len({q["upload_id"] for q in queries}) == 1


@pytest.mark.asyncio
async def test_upload_asset_legacy_firmware_falls_back_to_single_shot(
    async_client, db, redis, monkeypatch
):
    from app.utils import embedded_assets

    frame = await create_embedded_frame(async_client, db)
    monkeypatch.setattr(embedded_assets, "EMBEDDED_UPLOAD_CHUNK_BYTES", 4)
    data = b"aaaabbbbcc"
    device = FakeDevice([
        json_response({"path": "big.bin", "size": 4, "mtime": 1, "is_dir": False}),
        json_response({"path": "big.bin", "size": 10, "mtime": 2, "is_dir": False}),
    ])

    with patch(FETCH, new=device):
        payload = await embedded_assets.upload_asset(frame, redis, "/srv/assets/big.bin", data)

    assert payload["size"] == 10
    assert len(device.calls) == 2
    assert device.calls[1]["body"] == data
    assert "upload_id" not in _device_query(device.calls[1])
