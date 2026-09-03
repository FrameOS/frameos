import httpx
import pytest
from fastapi import HTTPException
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


def _asset(name: str, size: int) -> dict:
    return {
        "name": name,
        "size": size,
        "browser_download_url": f"https://github.com/FrameOS/frameos/releases/download/v1.3.0/{name}",
    }


@pytest.mark.asyncio
async def test_firmware_listing_includes_the_per_layout_images(async_client):
    # A release since docs/todo.md step 1 carries one image per chip and flash
    # layout next to the generic pair; the listing names each by its platform
    # and still never lists a bare -app.bin.
    release = {
        "tag_name": "v1.3.0",
        "assets": [
            *RELEASE["assets"],
            _asset("frameos-1.3.0-esp32-s3-32mb.bin", 70),
            _asset("frameos-1.3.0-esp32-s3-32mb-app.bin", 50),
            _asset("frameos-1.3.0-esp32-c3-16mb.bin", 40),
        ],
    }
    with patch_release(release=release):
        response = await async_client.get("/api/frames/firmware")

    assert response.status_code == 200, response.text
    assert [asset["platform"] for asset in response.json()["assets"]] == [
        "esp32-s3-generic",
        "esp32-c3-generic",
        "esp32-c3-16mb",
        "esp32-s3-32mb",
        "raspberry-pi-64",
    ]
    assert firmware_release_module.published_provisioning_assets(release) == {
        "esp32-s3-generic",
        "esp32-c3-generic",
        "esp32-c3-16mb",
        "esp32-s3-32mb",
        "raspberry-pi-64",
    }
    # No listing at all is "unknown", not "nothing published".
    assert firmware_release_module.published_provisioning_assets(None) is None
    # Every per-layout image is streamable like the generic ones.
    assert "esp32-c3-16mb" in firmware_release_module.STREAMABLE_PLATFORMS
    assert "esp32-s3-32mb" in firmware_release_module.STREAMABLE_PLATFORMS
    assert "raspberry-pi-64" not in firmware_release_module.STREAMABLE_PLATFORMS


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


# --- The device-facing OTA relay -------------------------------------------
#
# Same release, different asset: the provisioning route streams the MERGED
# image, the OTA routes the bare `-app.bin`. These exercise the helpers the
# device routes in app/api/embedded_device.py call.

MINISIG = (
    "untrusted comment: signature from minisign secret key\n"
    "RUQf6LRCGA9i55abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ==\n"
)


def patch_minisig(text=MINISIG):
    return patch(
        "app.api.firmware_release.fetch_release_asset_text",
        new_callable=AsyncMock,
        return_value=text,
    )


@pytest.mark.asyncio
async def test_latest_release_summary_names_the_release_and_its_platforms():
    with patch_release():
        summary = await firmware_release_module.latest_release_summary()

    assert summary == {
        "tag": "v1.2.3",
        # The device compares against esp_app_get_description()->version,
        # which is not v-prefixed.
        "version": "1.2.3",
        "platforms": {"esp32-s3-generic", "esp32-c3-generic", "raspberry-pi-64"},
    }
    assert firmware_release_module.release_version({"tag_name": "v2026.9.2"}) == "2026.9.2"
    assert firmware_release_module.release_version({"tag_name": "2026.9.2"}) == "2026.9.2"
    assert firmware_release_module.release_version({}) == ""


@pytest.mark.asyncio
async def test_latest_release_summary_is_none_when_github_is_unreachable():
    with patch_release(release=None):
        assert await firmware_release_module.latest_release_summary() is None


@pytest.mark.asyncio
async def test_ota_assets_name_the_bare_app_image_for_every_layout():
    assert set(firmware_release_module.OTA_ASSETS) == set(
        firmware_release_module.embedded_release_asset_names()
    )
    assert firmware_release_module.OTA_ASSETS["esp32-s3-16mb"] == "-esp32-s3-16mb-app.bin"
    # The merged provisioning image is never an OTA image: esp_ota_write
    # validates an esp_app_desc at offset 0x20, where the merged image has
    # the bootloader.
    asset = firmware_release_module.find_ota_asset(RELEASE, "esp32-s3-generic")
    assert asset["name"] == "frameos-1.2.3-esp32-s3-generic-app.bin"
    assert firmware_release_module.find_ota_asset(RELEASE, "esp32-c3-generic") is None
    assert firmware_release_module.find_ota_asset(RELEASE, "esp99-mega") is None


@pytest.mark.asyncio
async def test_ota_manifest_shape():
    signed = {
        "tag_name": "v1.2.3",
        "assets": [
            *RELEASE["assets"],
            _asset("frameos-1.2.3-esp32-s3-generic-app.bin.minisig", 120),
        ],
    }
    with patch_release(release=signed), patch_minisig():
        manifest = await firmware_release_module.latest_release_ota_manifest(
            "esp32-s3-generic", "/download/here"
        )

    assert manifest == {
        "platform": "esp32-s3-generic",
        "version": "1.2.3",
        "size": 48,
        "minisig": MINISIG,
        "downloadUrl": "/download/here",
    }


@pytest.mark.asyncio
async def test_ota_manifest_error_tokens():
    signed = {
        "tag_name": "v1.2.3",
        "assets": [
            *RELEASE["assets"],
            _asset("frameos-1.2.3-esp32-s3-generic-app.bin.minisig", 120),
        ],
    }

    async def manifest(release, platform, minisig=MINISIG):
        # Each case is its own lookup: the in-process listing cache would
        # otherwise answer the next one with the previous release.
        firmware_release_module.clear_release_cache()
        with patch_release(release=release), patch_minisig(text=minisig):
            with pytest.raises(HTTPException) as exc:
                await firmware_release_module.latest_release_ota_manifest(platform, "/d")
        return exc.value.status_code, exc.value.detail

    # 400: a platform with no published OTA image family at all.
    assert await manifest(signed, "esp99-mega") == (400, "invalid_platform")
    # 404: this release does not carry the app image.
    assert await manifest(RELEASE, "esp32-c3-generic") == (404, "ota_image_not_published")
    # 409: an app image the device could never verify.
    assert await manifest(RELEASE, "esp32-s3-generic") == (409, "unsigned_release")
    # 502: GitHub unreachable, and separately a signature we could not fetch.
    assert await manifest(None, "esp32-s3-generic") == (502, "release_lookup_failed")
    assert await manifest(signed, "esp32-s3-generic", minisig=None) == (502, "release_lookup_failed")


@pytest.mark.asyncio
async def test_fetch_release_asset_text_refuses_oversized_and_off_host_assets():
    # A minisign signature is a few hundred bytes; anything bigger is not one.
    oversized = _asset("frameos-1.3.0-esp32-s3-generic-app.bin.minisig", 1024 * 1024)
    assert await firmware_release_module.fetch_release_asset_text(oversized) is None

    off_host = {
        "name": "frameos-1.3.0-esp32-s3-generic-app.bin.minisig",
        "size": 120,
        "browser_download_url": "https://evil.example.com/sig.minisig",
    }
    assert await firmware_release_module.fetch_release_asset_text(off_host) is None

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=MINISIG.encode())

    real_async_client = httpx.AsyncClient

    def mocked_async_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs.pop("follow_redirects", None)
        return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

    good = _asset("frameos-1.3.0-esp32-s3-generic-app.bin.minisig", 120)
    with patch.object(httpx, "AsyncClient", mocked_async_client):
        assert await firmware_release_module.fetch_release_asset_text(good) == MINISIG


@pytest.mark.asyncio
async def test_release_asset_stream_forwards_a_range_and_relays_206():
    """Firmware from before the signed release OTA resumes its download in
    512 KB ranges. Refusing the Range would strand exactly the boards this
    relay exists to move onto the release image."""
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("range"))
        return httpx.Response(
            206,
            content=b"\xa5" * 16,
            headers={"content-length": "16", "content-range": "bytes 0-15/48"},
        )

    real_async_client = httpx.AsyncClient

    def mocked_async_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs.pop("follow_redirects", None)
        return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

    with patch_release(), patch.object(httpx, "AsyncClient", mocked_async_client):
        response = await firmware_release_module.stream_latest_release_ota_image(
            "esp32-s3-generic", range_header="bytes=0-15"
        )

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-15/48"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["x-frameos-image-name"] == "frameos-1.2.3-esp32-s3-generic-app.bin"
    assert seen == ["bytes=0-15"]
    assert b"".join([chunk async for chunk in response.body_iterator]) == b"\xa5" * 16


@pytest.mark.asyncio
async def test_stream_latest_release_ota_image_error_tokens():
    async def stream(release, platform):
        firmware_release_module.clear_release_cache()
        with patch_release(release=release):
            with pytest.raises(HTTPException) as exc:
                await firmware_release_module.stream_latest_release_ota_image(platform)
        return exc.value.status_code, exc.value.detail

    assert await stream(RELEASE, "esp99-mega") == (400, "invalid_platform")
    assert await stream(RELEASE, "esp32-c3-generic") == (404, "ota_image_not_published")
    assert await stream(None, "esp32-s3-generic") == (502, "release_lookup_failed")
