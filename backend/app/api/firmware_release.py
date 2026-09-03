"""Stock-release firmware: the listing + byte pipe for the browser flasher,
and the release-manifest relay behind the device's OTA routes.

Python port of the cloud's GET /api/frames/firmware route
(cloud/apps/auth-web/app/api/frames/firmware/route.ts, allow-list logic in
cloud/apps/auth-web/src/lib/firmware-release.ts). The self-hosted SPA's
flasher and "Update over USB" flow fetch the same same-origin path, so a
backend must answer it too; the device-facing OTA manifest/download in
app/api/embedded_device.py resolve the release through the helpers here.

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

from app.tasks.embedded_firmware import embedded_release_asset_names

from . import api_project

RELEASE_API_URL = "https://api.github.com/repos/FrameOS/frameos/releases/latest"

# Explicit allow-list of platform -> exact asset suffix. The ESP32 entries
# come from the flash profiles (EMBEDDED_FLASH_PROFILES.releaseAssets, one
# image per chip and flash layout, generic first) — the same table the
# provisioning plan picks from, so the listing and the plan cannot disagree
# about what exists. The cloud's firmware-release.ts provisioningAssets lists
# only the generic pair; the esp32 jobs in
# .github/workflows/docker-publish-multi.yml publish all of them. These are
# the MERGED provisioning images (bootloader at 0x0, partition table, blank
# otadata, app) — what a flasher writes to a board, not the bare OTA app image.
PROVISIONING_ASSETS: list[dict[str, str]] = [
    *({"platform": asset, "suffix": f"-{asset}.bin"} for asset in embedded_release_asset_names()),
    {"platform": "esp32-s3-epd7in5v2", "suffix": "-esp32-s3-epd7in5v2.bin"},
    {"platform": "raspberry-pi-32", "suffix": "-raspberry-pi-32-buildroot.img.gz"},
    {"platform": "raspberry-pi-64", "suffix": "-raspberry-pi-64-buildroot.img.gz"},
    {"platform": "raspberry-pi-5", "suffix": "-raspberry-pi-5-buildroot.img.gz"},
]

# Only the ESP32 firmware (a few MB) is ever streamed from here; the
# gigabyte-sized buildroot SD images appear in the listing but are not
# streamable through this route.
STREAMABLE_PLATFORMS = {
    entry["platform"] for entry in PROVISIONING_ASSETS if entry["platform"].startswith("esp32-")
}

# OTA images. NOT the same file as the provisioning image, and the difference
# is the whole reason this list exists: PROVISIONING_ASSETS points at the
# MERGED image (bootloader at 0x0, partition table, blank otadata, app), which
# is what a flasher writes to a blank board. An OTA slot takes only the bare
# app image: esp_ota_write/esp_ota_end validate an esp_app_desc at offset
# 0x20, and the merged image has the BOOTLOADER there. The release publishes
# both (`-app.bin` beside every `.bin`); the device-authed manifest/download
# routes serve this one, for the flash layout the device names.
OTA_ASSETS: dict[str, str] = {asset: f"-{asset}-app.bin" for asset in embedded_release_asset_names()}

# A minisign signature file is a comment line plus two short base64 lines —
# a few hundred bytes. Anything bigger than this is not a signature.
MAX_SIGNATURE_ASSET_BYTES = 4096

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


def published_provisioning_assets(release: Optional[dict[str, Any]]) -> Optional[set[str]]:
    """The provisioning platforms a release listing actually carries, or None
    when there is no listing to read (the provisioning plan then falls back
    to the generic image rather than guessing)."""
    if release is None:
        return None
    return {entry["platform"] for entry in PROVISIONING_ASSETS if _find_asset(release, entry["suffix"])}


async def latest_published_provisioning_assets() -> Optional[set[str]]:
    """Same, for the cached latest release — what the provisioning route asks."""
    return published_provisioning_assets(await _latest_release_cached())


def release_version(release: dict[str, Any]) -> str:
    """Release tags are v-prefixed ("v2026.9.2"); the device compares against
    esp_app_get_description()->version, which is not."""
    tag = str(release.get("tag_name") or "")
    return tag[1:] if tag.startswith("v") else tag


async def latest_release_summary() -> Optional[dict[str, Any]]:
    """The cached latest release as ``{"tag", "version", "platforms"}`` —
    what the deploy plan names — or None when GitHub is unreachable."""
    release = await _latest_release_cached()
    if release is None:
        return None
    return {
        "tag": str(release.get("tag_name") or ""),
        "version": release_version(release),
        "platforms": published_provisioning_assets(release) or set(),
    }


def find_ota_asset(release: dict[str, Any], platform: str) -> Optional[dict[str, Any]]:
    """The bare app image for a platform, or None on an older release."""
    suffix = OTA_ASSETS.get(platform)
    return _find_asset(release, suffix) if suffix else None


async def fetch_release_asset_text(asset: dict[str, Any]) -> Optional[str]:
    """The full text of a small release asset (the .minisig files), or None
    when it is oversized, off-host or unfetchable."""
    size = asset.get("size")
    if isinstance(size, int) and size > MAX_SIGNATURE_ASSET_BYTES:
        return None
    url = _pinned_asset_url(asset)
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.get(url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or len(response.content) > MAX_SIGNATURE_ASSET_BYTES:
        return None
    return response.text


async def latest_release_ota_manifest(platform: str, download_url: str) -> dict[str, Any]:
    """The OTA manifest the device understands (embedded/esp32/main/fos_ota.c,
    same shape as the cloud's /api/frames/{id}/firmware/manifest):
    ``{platform, version, size, minisig, downloadUrl}``. Raises HTTPException
    with the cloud's error tokens: 400 invalid_platform, 404
    ota_image_not_published, 409 unsigned_release, 502 release_lookup_failed.
    """
    if platform not in OTA_ASSETS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="invalid_platform")
    release = await _latest_release_cached()
    if release is None:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")
    asset = find_ota_asset(release, platform)
    if asset is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="ota_image_not_published")
    signature = _find_asset(release, f"{OTA_ASSETS[platform]}.minisig")
    if signature is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="unsigned_release")
    minisig = await fetch_release_asset_text(signature)
    if not minisig:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")
    return {
        "platform": platform,
        "version": release_version(release),
        "size": asset.get("size"),
        "minisig": minisig,
        "downloadUrl": download_url,
    }


async def stream_latest_release_ota_image(platform: str, range_header: Optional[str] = None) -> StreamingResponse:
    """Pipe the release's bare app image for ``platform`` to the device."""
    if platform not in OTA_ASSETS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="invalid_platform")
    release = await _latest_release_cached()
    if release is None:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")
    asset = find_ota_asset(release, platform)
    if asset is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="ota_image_not_published")
    return await _stream_release_asset(asset, str(release.get("tag_name") or ""), range_header=range_header)


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


async def _stream_release_asset(
    asset: dict[str, Any], release_tag: str, range_header: Optional[str] = None
) -> StreamingResponse:
    """Pipe one release asset straight through — the bytes are never buffered.

    A ``Range`` header is forwarded and a 206 relayed as-is: firmware from
    before the signed release OTA (esp_https_ota with partial downloads)
    resumes its download in 512 KB ranges, and it must keep updating — that
    is how such a board reaches the release image at all."""
    url = _pinned_asset_url(asset)
    if not url:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="release_lookup_failed")

    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=True)
    request_headers = {"Range": range_header} if range_header else None
    try:
        upstream = await client.send(client.build_request("GET", url, headers=request_headers), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="firmware_download_failed")
    if upstream.status_code not in (200, 206):
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="firmware_download_failed")

    headers = {
        "cache-control": "private, max-age=300",
        "accept-ranges": "bytes",
        "x-frameos-image-name": str(asset.get("name") or ""),
        "x-frameos-release": release_tag,
    }
    for name in ("content-length", "content-range"):
        value = upstream.headers.get(name)
        if value:
            headers[name] = value

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body(), status_code=upstream.status_code, media_type="application/octet-stream", headers=headers
    )


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
