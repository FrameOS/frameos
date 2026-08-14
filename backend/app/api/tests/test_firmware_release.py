import httpx
import pytest
from unittest.mock import AsyncMock, patch

from app.api import firmware_release as firmware_release_module


RELEASE = {
    "tag_name": "v1.2.3",
    "assets": [
        {
            "name": "frameos-1.2.3-esp32-s3-generic.bin",
            "size": 64,
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic.bin",
        },
        {
            "name": "frameos-1.2.3-esp32-c3-generic.bin",
            "size": 32,
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-c3-generic.bin",
        },
        # The bare OTA app image must never be listed as a provisioning asset.
        {
            "name": "frameos-1.2.3-esp32-s3-generic-app.bin",
            "size": 48,
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-esp32-s3-generic-app.bin",
        },
        {
            "name": "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
            "size": 1024,
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
        },
        # Not a frameos- asset: ignored by the allow-list.
        {
            "name": "sources.tar.gz",
            "size": 10,
            "browser_download_url": "https://github.com/FrameOS/frameos/releases/download/v1.2.3/sources.tar.gz",
        },
    ],
}


@pytest.fixture(autouse=True)
def clear_release_cache(monkeypatch):
    firmware_release_module.clear_release_cache()
    monkeypatch.delenv(firmware_release_module.LOCAL_FIRMWARE_ENV, raising=False)
    yield
    firmware_release_module.clear_release_cache()


def patch_release(release=RELEASE):
    return patch(
        "app.api.firmware_release._fetch_latest_release",
        new_callable=AsyncMock,
        return_value=release,
    )


@pytest.mark.asyncio
async def test_firmware_listing(async_client):
    with patch_release() as fetch:
        response = await async_client.get("/api/frames/firmware")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["release"] == "v1.2.3"
    assert payload["assets"] == [
        {"name": "frameos-1.2.3-esp32-s3-generic.bin", "platform": "esp32-s3-generic", "size": 64},
        {"name": "frameos-1.2.3-esp32-c3-generic.bin", "platform": "esp32-c3-generic", "size": 32},
        {
            "name": "frameos-1.2.3-raspberry-pi-64-buildroot.img.gz",
            "platform": "raspberry-pi-64",
            "size": 1024,
        },
    ]
    fetch.assert_awaited_once()

    # The second listing is answered from the in-process cache: GitHub's
    # unauthenticated API is 60 requests/hour per IP.
    with patch_release() as second_fetch:
        response = await async_client.get("/api/frames/firmware")
    assert response.status_code == 200
    second_fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_firmware_listing_502_when_github_unreachable(async_client):
    with patch_release(release=None):
        response = await async_client.get("/api/frames/firmware")
    assert response.status_code == 502
    assert response.json()["detail"] == "release_lookup_failed"


@pytest.mark.asyncio
async def test_firmware_platform_streams_release_asset(async_client):
    firmware_bytes = b"\xe9" + b"\xa5" * 63
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        return httpx.Response(
            200,
            content=firmware_bytes,
            headers={"content-length": str(len(firmware_bytes))},
        )

    real_async_client = httpx.AsyncClient

    def mocked_async_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs.pop("follow_redirects", None)
        return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

    with patch_release(), patch.object(httpx, "AsyncClient", mocked_async_client):
        response = await async_client.get("/api/frames/firmware?platform=esp32-s3-generic")

    assert response.status_code == 200, response.text
    assert response.content == firmware_bytes
    assert response.headers["content-type"] == "application/octet-stream"
    # No content-length assertion: the app-wide GZipMiddleware re-encodes the
    # stream for gzip-accepting clients and drops it. The SPA sizes its
    # progress display from the listing's `size` field instead.
    assert response.headers["x-frameos-image-name"] == "frameos-1.2.3-esp32-s3-generic.bin"
    assert response.headers["x-frameos-release"] == "v1.2.3"
    assert requested_urls == [RELEASE["assets"][0]["browser_download_url"]]


@pytest.mark.asyncio
async def test_firmware_platform_rejects_off_host_asset_url(async_client):
    # Belt and braces: even if the GitHub API response pointed elsewhere, the
    # pipe refuses to follow it.
    hijacked = {
        "tag_name": "v1.2.3",
        "assets": [
            {
                "name": "frameos-1.2.3-esp32-s3-generic.bin",
                "size": 64,
                "browser_download_url": "https://evil.example.com/frameos-1.2.3-esp32-s3-generic.bin",
            },
        ],
    }
    with patch_release(release=hijacked):
        response = await async_client.get("/api/frames/firmware?platform=esp32-s3-generic")
    assert response.status_code == 502
    assert response.json()["detail"] == "release_lookup_failed"


@pytest.mark.asyncio
async def test_firmware_unknown_platform(async_client):
    # Not in the streamable allow-list at all -> 400.
    with patch_release():
        response = await async_client.get("/api/frames/firmware?platform=esp99-mega")
    assert response.status_code == 400
    assert response.json()["detail"] == "invalid_platform"

    # SD images are listed but never streamed through this route.
    with patch_release():
        response = await async_client.get("/api/frames/firmware?platform=raspberry-pi-64")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_firmware_platform_not_published_404(async_client):
    without_c3 = {
        "tag_name": "v1.0.0",
        "assets": [asset for asset in RELEASE["assets"] if "c3" not in asset["name"]],
    }
    with patch_release(release=without_c3):
        response = await async_client.get("/api/frames/firmware?platform=esp32-c3-generic")
    assert response.status_code == 404
    assert response.json()["detail"] == "firmware_not_published"


@pytest.mark.asyncio
async def test_dev_override_serves_local_file(async_client, tmp_path, monkeypatch):
    local = tmp_path / "merged-binary.bin"
    local.write_bytes(b"\xe9local-dev-image")
    monkeypatch.setenv(firmware_release_module.LOCAL_FIRMWARE_ENV, str(local))

    # A release without the generic asset: the local build fills the gap.
    without_generic = {
        "tag_name": "v0.9.0",
        "assets": [asset for asset in RELEASE["assets"] if "s3-generic.bin" not in asset["name"]],
    }
    with patch_release(release=without_generic):
        listing = await async_client.get("/api/frames/firmware")
    assert listing.status_code == 200
    assets = listing.json()["assets"]
    assert assets[0] == {
        "name": "merged-binary.bin",
        "platform": "esp32-s3-generic",
        "size": local.stat().st_size,
    }

    with patch_release(release=without_generic):
        response = await async_client.get("/api/frames/firmware?platform=esp32-s3-generic")
    assert response.status_code == 200
    assert response.content == b"\xe9local-dev-image"
    assert response.headers["x-frameos-release"] == "local-dev"
    assert response.headers["x-frameos-image-name"] == "merged-binary.bin"


@pytest.mark.asyncio
async def test_dev_override_wins_only_when_release_lacks_the_asset(async_client, tmp_path, monkeypatch):
    local = tmp_path / "merged-binary.bin"
    local.write_bytes(b"\xe9local-dev-image")
    monkeypatch.setenv(firmware_release_module.LOCAL_FIRMWARE_ENV, str(local))

    with patch_release():
        listing = await async_client.get("/api/frames/firmware")
    assert listing.status_code == 200
    generic = [asset for asset in listing.json()["assets"] if asset["platform"] == "esp32-s3-generic"]
    # The published release wins over the local build.
    assert generic == [
        {"name": "frameos-1.2.3-esp32-s3-generic.bin", "platform": "esp32-s3-generic", "size": 64},
    ]


@pytest.mark.asyncio
async def test_dev_override_survives_github_outage(async_client, tmp_path, monkeypatch):
    # Documented divergence from the cloud route: a self-hosted box without
    # internet can still flash the locally built image.
    local = tmp_path / "merged-binary.bin"
    local.write_bytes(b"\xe9local-dev-image")
    monkeypatch.setenv(firmware_release_module.LOCAL_FIRMWARE_ENV, str(local))

    with patch_release(release=None):
        listing = await async_client.get("/api/frames/firmware")
        response = await async_client.get("/api/frames/firmware?platform=esp32-s3-generic")

    assert listing.status_code == 200
    assert listing.json() == {
        "assets": [
            {"name": "merged-binary.bin", "platform": "esp32-s3-generic", "size": local.stat().st_size},
        ],
        "release": "",
    }
    assert response.status_code == 200
    assert response.content == b"\xe9local-dev-image"


@pytest.mark.asyncio
async def test_firmware_requires_auth(no_auth_client):
    with patch_release() as fetch:
        response = await no_auth_client.get("/api/projects/1/frames/firmware")
    assert response.status_code == 401
    fetch.assert_not_awaited()
