"""Stock-release firmware listing + byte pipe for the browser flasher.

Python port of the cloud's GET /api/frames/firmware route
(cloud/apps/auth-web/app/api/frames/firmware/route.ts, allow-list logic in
cloud/apps/auth-web/src/lib/firmware-release.ts). The self-hosted SPA's
"Update over USB" flow (EmbeddedUsbFirmwareUpdate.tsx) fetches the same
same-origin path, so a backend must answer it too.

Nothing in the browser may talk to GitHub directly: the release-asset 302 from
github.com carries no access-control-allow-origin header (the download always
fails CORS), and unauthenticated api.github.com is 60 requests/hour per IP.
So both the listing and the bytes come from here — the listing from a small
in-process cache, the bytes as a straight streaming pipe that never buffers
the firmware.

Two shapes, mirroring the cloud:
  GET /api/frames/firmware
    -> { "release": "vX.Y.Z", "assets": [{ name, platform, size }] }
  GET /api/frames/firmware?platform=esp32-s3-generic
    -> the merged .bin bytes, streamed.

Documented divergences from the cloud route:
  - Auth is the backend's normal project-scoped session auth (router-level
    get_current_project dependency on api_project), not the cloud session
    cookie; there is no separate per-route rate limit — the GitHub budget is
    protected by the listing cache instead.
  - The listing cache is ~10 minutes (the cloud revalidates at 5) and a failed
    lookup is cached briefly too, so a GitHub outage cannot burn the 60/h
    budget.
  - When GitHub is unreachable but FRAMEOS_ESP32_GENERIC_FIRMWARE points at a
    local merged image, the route still serves that image instead of failing
    with 502 — a self-hosted box without internet can keep flashing.
"""

import os
import time
from http import HTTPStatus
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import api_project

RELEASE_API_URL = "https://api.github.com/repos/FrameOS/frameos/releases/latest"

# Explicit allow-list of platform -> exact asset suffix, kept in sync with
# firmware-release.ts provisioningAssets (which is kept in sync with the esp32
# job in .github/workflows/docker-publish-multi.yml). These are the MERGED
# provisioning images (bootloader at 0x0, partition table, blank otadata, app)
# — what a flasher writes to a board, not the bare OTA app image.
PROVISIONING_ASSETS: list[dict[str, str]] = [
    {"platform": "esp32-s3-generic", "suffix": "-esp32-s3-generic.bin"},
    {"platform": "esp32-s3-epd7in5v2", "suffix": "-esp32-s3-epd7in5v2.bin"},
    {"platform": "esp32-c3-generic", "suffix": "-esp32-c3-generic.bin"},
    {"platform": "raspberry-pi-zero-2-w", "suffix": "-raspberry-pi-zero-2-w-buildroot.img.gz"},
    {"platform": "raspberry-pi-zero-w", "suffix": "-raspberry-pi-zero-w-buildroot.img.gz"},
]

# Only the ESP32 firmware (a few MB) is ever streamed from here; the
# gigabyte-sized buildroot SD images appear in the listing but are not
# streamable through this route.
STREAMABLE_PLATFORMS = {
    "esp32-s3-generic",
    "esp32-s3-epd7in5v2",
    "esp32-c3-generic",
}

# Development / self-hosted escape hatch: point this at a locally built merged
# binary (embedded/esp32/build*/merged-binary.bin). Advertised and served only
# when the release itself has no generic asset, so a published release wins.
LOCAL_FIRMWARE_ENV = "FRAMEOS_ESP32_GENERIC_FIRMWARE"

# GitHub releases change rarely and unauthenticated api.github.com is
# 60 requests/hour per IP; cache the listing well clear of that.
RELEASE_CACHE_SECONDS = 600
RELEASE_FAILURE_CACHE_SECONDS = 60

_release_cache: dict[str, Any] = {"at": 0.0, "release": None}


def clear_release_cache() -> None:
    """Reset the in-process release cache (tests)."""
    _release_cache["at"] = 0.0
    _release_cache["release"] = None


def _local_generic_firmware() -> Optional[dict[str, Any]]:
    path = (os.environ.get(LOCAL_FIRMWARE_ENV) or "").strip()
    if not path:
        return None
    try:
        if not os.path.isfile(path):
            return None
        return {"name": os.path.basename(path), "path": path, "size": os.path.getsize(path)}
    except OSError:
        return None


async def _fetch_latest_release() -> Optional[dict[str, Any]]:
    """The latest release's raw JSON from GitHub, or None. Tests patch this."""
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.get(
                RELEASE_API_URL,
                headers={"Accept": "application/vnd.github+json"},
            )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


async def _latest_release_cached() -> Optional[dict[str, Any]]:
    now = time.monotonic()
    ttl = RELEASE_CACHE_SECONDS if _release_cache["release"] is not None else RELEASE_FAILURE_CACHE_SECONDS
    if _release_cache["at"] and now - _release_cache["at"] < ttl:
        return _release_cache["release"]
    release = await _fetch_latest_release()
    _release_cache["at"] = now
    _release_cache["release"] = release
    return release


def _find_asset(release: dict[str, Any], suffix: str) -> Optional[dict[str, Any]]:
    for asset in release.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        name = asset.get("name")
        if isinstance(name, str) and name.startswith("frameos-") and name.endswith(suffix):
            return asset
    return None


def _pinned_asset_url(asset: dict[str, Any]) -> Optional[str]:
    """Belt and braces: asset URLs come from the GitHub API, but pin the host
    anyway so a compromised/unexpected API response cannot redirect us."""
    url = asset.get("browser_download_url")
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme != "https" or parts.netloc != "github.com":
        return None
    return url


async def _stream_release_asset(asset: dict[str, Any], release_tag: str) -> StreamingResponse:
    """Pipe one release asset straight through — the bytes are never buffered."""
    url = _pinned_asset_url(asset)
    if not url:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=True)
    try:
        upstream = await client.send(client.build_request("GET", url), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="firmware_download_failed")
    if upstream.status_code != 200:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="firmware_download_failed")

    headers = {
        "cache-control": "private, max-age=300",
        "x-frameos-image-name": str(asset.get("name") or ""),
        "x-frameos-release": release_tag,
    }
    content_length = upstream.headers.get("content-length")
    if content_length:
        headers["content-length"] = content_length

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), media_type="application/octet-stream", headers=headers)


@api_project.get("/frames/firmware")
async def api_frames_firmware_release(platform: Optional[str] = Query(None)):
    listing = platform is None
    if not listing and platform not in STREAMABLE_PLATFORMS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="invalid_platform")

    release = await _latest_release_cached()
    local = _local_generic_firmware()
    if release is None and local is None:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")
    release = release or {}
    release_tag = str(release.get("tag_name") or "")

    if listing:
        assets = []
        for entry in PROVISIONING_ASSETS:
            asset = _find_asset(release, entry["suffix"])
            if asset:
                assets.append({
                    "name": asset.get("name"),
                    "platform": entry["platform"],
                    "size": asset.get("size"),
                })
        if local and not any(asset["platform"] == "esp32-s3-generic" for asset in assets):
            assets.insert(0, {
                "name": local["name"],
                "platform": "esp32-s3-generic",
                "size": local["size"],
            })
        return JSONResponse(
            {"assets": assets, "release": release_tag},
            headers={"cache-control": "private, max-age=300"},
        )

    entry = next((candidate for candidate in PROVISIONING_ASSETS if candidate["platform"] == platform), None)
    asset = _find_asset(release, entry["suffix"]) if entry else None
    if asset is None and platform == "esp32-s3-generic" and local:
        return FileResponse(
            local["path"],
            media_type="application/octet-stream",
            headers={
                "cache-control": "no-store",
                "x-frameos-image-name": local["name"],
                "x-frameos-release": "local-dev",
            },
        )
    if asset is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="firmware_not_published")
    return await _stream_release_asset(asset, release_tag)
