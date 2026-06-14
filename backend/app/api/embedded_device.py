"""Device-facing endpoints for embedded (ESP32) frames.

The microcontroller authenticates with its ``server_api_key`` as a Bearer
token (same scheme as ``/api/log``). Three endpoints:

- ``GET /api/frames/{id}/embedded/render`` — a diagnostic thin-client bitmap.
  Normal scenes render on-device via the Nim runtime; this route gives remote
  render mode a simple end-to-end bitmap in the panel's wire format.
- ``GET /api/frames/{id}/embedded/ota/manifest`` — sha256/size of the latest
  OTA app image so the device can decide whether to update.
- ``GET /api/frames/{id}/embedded/ota/download`` — the OTA app image
  (``frameos_esp32.bin``, not the merged flash image).
- ``GET /api/frames/{id}/embedded/scenes`` — the frame's scenes as a JSON
  array (interpreted scenes: QuickJS + AOT app library on-device). The
  ETag is the payload's sha256; devices poll with ``If-None-Match`` and get
  304 when nothing changed, so hot scene updates need no reflash.

Wire format for /render ("FOSB"): magic ``FOSB``, version u8 (1), pixel
format u8 (see ``fos_pixel_format_t``), width u16le, height u16le, reserved
u16, then the packed payload bytes for that format.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import struct
from asyncio import get_running_loop
from datetime import datetime, timezone
from http import HTTPStatus
from urllib.parse import urlparse

import httpx
from fastapi import Depends, Header, HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.database import get_db
from app.drivers.devices import device_dimensions
from app.models.frame import Frame, get_frame_json
from app.tasks.embedded_firmware import (
    FOS_PIXEL_1BPP,
    FOS_PIXEL_2BPP_BWYR,
    FOS_PIXEL_2BPP_GRAY,
    FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_GRAY,
    FOS_PIXEL_4BPP_SPECTRA6,
    FOS_PIXEL_DUAL_1BPP_RED,
    FOS_PIXEL_DUAL_1BPP_YELLOW,
    embedded_buffer_size,
    embedded_panel_for_frame,
    embedded_pixel_format_for_panel,
    latest_embedded_firmware,
)
from . import api_public

DEFAULT_WIDTH = 800
DEFAULT_HEIGHT = 480
EMBEDDED_MEDIA_MAX_SOURCE_BYTES = 16 * 1024 * 1024
EMBEDDED_MEDIA_TIMEOUT_SECONDS = 45.0
EMBEDDED_MEDIA_FORMAT = "BMP"
EMBEDDED_MEDIA_MAX_OUTPUT_WIDTH = 400
EMBEDDED_MEDIA_MAX_OUTPUT_HEIGHT = 240
GALLERY_CATEGORY_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

BWYR_PALETTE = [
    (57, 48, 57),
    (255, 255, 255),
    (208, 190, 71),
    (156, 72, 75),
]
SPECTRA6_PALETTE = [
    (25, 20, 38),
    (178, 193, 192),
    (199, 187, 0),
    (107, 17, 25),
    (999, 999, 999),
    (24, 83, 154),
    (42, 85, 49),
]
SEVEN_COLOR_PALETTE = [
    (57, 48, 57),
    (255, 255, 255),
    (58, 91, 70),
    (61, 59, 94),
    (156, 72, 75),
    (208, 190, 71),
    (177, 106, 73),
]


def _embedded_frame_from_bearer(db: Session, frame_id: int, authorization: str | None) -> Frame:
    if not authorization:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Invalid Authorization header")
    frame = db.query(Frame).filter_by(server_api_key=parts[1]).first()
    if not frame or int(frame.id) != frame_id:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    if (frame.mode or "rpios") != "embedded":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not an embedded frame")
    return frame


def embedded_render_dimensions(frame: Frame) -> tuple[int, int]:
    dims = device_dimensions(frame.device)
    if dims:
        return dims
    if frame.width and frame.height:
        return int(frame.width), int(frame.height)
    return DEFAULT_WIDTH, DEFAULT_HEIGHT


def _validate_embedded_media_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Missing media URL")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Media URL must be HTTP or HTTPS")
    if len(url) > 4096:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Media URL is too long")
    return url


async def _fetch_embedded_media_source(url: str) -> bytes:
    timeout = httpx.Timeout(EMBEDDED_MEDIA_TIMEOUT_SECONDS, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > EMBEDDED_MEDIA_MAX_SOURCE_BYTES:
                        raise HTTPException(
                            status_code=HTTPStatus.PAYLOAD_TOO_LARGE,
                            detail=f"Source image exceeds {EMBEDDED_MEDIA_MAX_SOURCE_BYTES} bytes",
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Source image request failed with HTTP {exc.response.status_code}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Source image request failed: {exc}") from exc


def _render_embedded_media(image_bytes: bytes, width: int, height: int, fit: str) -> bytes:
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            if fit == "contain":
                contained = ImageOps.contain(image, (width, height), Image.Resampling.LANCZOS)
                canvas = Image.new("RGB", (width, height), "white")
                canvas.paste(contained, ((width - contained.width) // 2, (height - contained.height) // 2))
                image = canvas
            else:
                image = ImageOps.fit(image, (width, height), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
            out = io.BytesIO()
            image.save(out, format=EMBEDDED_MEDIA_FORMAT)
            return out.getvalue()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Source image could not be decoded: {exc}") from exc


def embedded_media_output_dimensions(
    frame_width: int,
    frame_height: int,
    requested_width: int | None = None,
    requested_height: int | None = None,
) -> tuple[int, int]:
    if requested_width and requested_width > 0 and requested_height and requested_height > 0:
        return (
            max(1, min(int(requested_width), frame_width, EMBEDDED_MEDIA_MAX_OUTPUT_WIDTH)),
            max(1, min(int(requested_height), frame_height, EMBEDDED_MEDIA_MAX_OUTPUT_HEIGHT)),
        )

    scale = min(
        EMBEDDED_MEDIA_MAX_OUTPUT_WIDTH / max(1, frame_width),
        EMBEDDED_MEDIA_MAX_OUTPUT_HEIGHT / max(1, frame_height),
        1.0,
    )
    return max(1, round(frame_width * scale)), max(1, round(frame_height * scale))


def _nearest_palette_index(rgb: tuple[int, int, int], palette: list[tuple[int, int, int]]) -> int:
    r, g, b = rgb
    return min(
        range(len(palette)),
        key=lambda i: abs(r - palette[i][0]) + abs(g - palette[i][1]) + abs(b - palette[i][2]),
    )


def _pack_1bpp(image) -> bytes:
    return image.convert("1").tobytes()


def _pack_dual_1bpp(image, accent: tuple[int, int, int]) -> bytes:
    palette = [(0, 0, 0), accent, (255, 255, 255)]
    row = (image.width + 7) // 8
    black = bytearray([0xFF] * (row * image.height))
    color = bytearray([0xFF] * (row * image.height))
    rgb = image.convert("RGB")
    for y in range(image.height):
        for x in range(image.width):
            index = _nearest_palette_index(rgb.getpixel((x, y)), palette)
            bit = 0x80 >> (x & 7)
            offset = y * row + (x >> 3)
            if index == 0:
                black[offset] &= ~bit
            elif index == 1:
                color[offset] &= ~bit
    return bytes(black + color)


def _pack_2bpp_gray(image) -> bytes:
    row = (image.width + 3) // 4
    out = bytearray(row * image.height)
    gray = image.convert("L")
    for y in range(image.height):
        for x in range(image.width):
            value = round(gray.getpixel((x, y)) * 3 / 255)
            out[y * row + (x >> 2)] |= (value & 0x03) << (6 - ((x & 3) * 2))
    return bytes(out)


def _pack_4bpp_gray(image) -> bytes:
    row = (image.width + 1) // 2
    out = bytearray(row * image.height)
    gray = image.convert("L")
    for y in range(image.height):
        for x in range(image.width):
            value = round(gray.getpixel((x, y)) * 15 / 255)
            out[y * row + (x >> 1)] |= (value & 0x0F) << (4 if (x & 1) == 0 else 0)
    return bytes(out)


def _pack_palette(image, palette: list[tuple[int, int, int]], bits: int) -> bytes:
    divider = 4 if bits == 2 else 2
    row = (image.width + divider - 1) // divider
    out = bytearray(row * image.height)
    rgb = image.convert("RGB")
    for y in range(image.height):
        for x in range(image.width):
            index = _nearest_palette_index(rgb.getpixel((x, y)), palette)
            if bits == 2:
                out[y * row + (x >> 2)] |= (index & 0x03) << (6 - ((x & 3) * 2))
            else:
                out[y * row + (x >> 1)] |= (index & 0x0F) << (4 if (x & 1) == 0 else 0)
    return bytes(out)


def render_embedded_diagnostic_bitmap(frame: Frame, width: int, height: int, pixel_format: int) -> bytes:
    """Readable diagnostic card packed in the panel format.

    Real scene rendering happens on-device in local mode. This exists so
    thin-client mode has a deterministic bitmap to fetch end to end.
    """
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle([4, 4, width - 5, height - 5], outline=(0, 0, 0), width=3)
    swatches = [
        (0, 0, 0),
        (255, 255, 255),
        (208, 190, 71),
        (156, 72, 75),
        (24, 83, 154),
        (42, 85, 49),
        (177, 106, 73),
        (128, 128, 128),
    ]
    bar_width = max(1, (width - 48) // len(swatches))
    for i, color in enumerate(swatches):
        draw.rectangle([24 + i * bar_width, 24, 24 + (i + 1) * bar_width, 64], fill=color)
    name = frame.name or f"Frame {frame.id}"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    draw.text((32, height * 0.30), "FrameOS", fill=(0, 0, 0))
    draw.text((32, height * 0.40), name, fill=(0, 0, 0))
    draw.text((32, height * 0.50), f"Backend diagnostic bitmap - {stamp}", fill=(0, 0, 0))
    draw.text((32, height * 0.60), "Scenes render on-device in local mode", fill=(0, 0, 0))

    if pixel_format == FOS_PIXEL_1BPP:
        return _pack_1bpp(image)
    if pixel_format == FOS_PIXEL_DUAL_1BPP_RED:
        return _pack_dual_1bpp(image, (255, 0, 0))
    if pixel_format == FOS_PIXEL_DUAL_1BPP_YELLOW:
        return _pack_dual_1bpp(image, (255, 255, 0))
    if pixel_format == FOS_PIXEL_2BPP_GRAY:
        return _pack_2bpp_gray(image)
    if pixel_format == FOS_PIXEL_2BPP_BWYR:
        return _pack_palette(image, BWYR_PALETTE, 2)
    if pixel_format == FOS_PIXEL_4BPP_7COLOR:
        return _pack_palette(image, SEVEN_COLOR_PALETTE, 4)
    if pixel_format == FOS_PIXEL_4BPP_SPECTRA6:
        return _pack_palette(image, SPECTRA6_PALETTE, 4)
    if pixel_format == FOS_PIXEL_4BPP_GRAY:
        return _pack_4bpp_gray(image)
    raise ValueError(f"Unsupported embedded pixel format: {pixel_format}")


def fosb_payload(width: int, height: int, pixel_format: int, packed: bytes) -> bytes:
    header = b"FOSB" + struct.pack("<BBHHH", 1, pixel_format, width, height, 0)
    return header + packed


@api_public.get("/frames/{id:int}/embedded/render")
async def api_embedded_device_render(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    width, height = embedded_render_dimensions(frame)
    pixel_format = embedded_pixel_format_for_panel(embedded_panel_for_frame(frame))
    packed = render_embedded_diagnostic_bitmap(frame, width, height, pixel_format)
    expected = embedded_buffer_size(width, height, pixel_format)
    if len(packed) != expected:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                            detail=f"packed buffer {len(packed)} != expected {expected}")
    return Response(content=fosb_payload(width, height, pixel_format, packed),
                    media_type="application/octet-stream")


def embedded_scenes_payload(frame: Frame) -> bytes:
    """The frame's scenes as the JSON array the on-device interpreter loads.

    Embedded frames run every scene interpreted (there is no on-device
    compiler), so unlike Linux fast-deploy this does not filter on
    ``settings.execution``.
    """
    scenes = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    return json.dumps(scenes, separators=(",", ":"), sort_keys=True).encode("utf-8")


def embedded_settings_payload(db: Session, frame: Frame) -> dict:
    frame_settings = get_frame_json(db, frame).get("settings") or {}
    payload = {
        "embedded": {
            "imageProxyFallback": bool(frame.image_proxy_fallback),
        },
    }
    if not isinstance(frame_settings, dict):
        return payload
    for key in ("openAI", "unsplash"):
        value = frame_settings.get(key)
        if isinstance(value, dict):
            payload[key] = value
    return payload


@api_public.get("/frames/{id:int}/embedded/scenes")
async def api_embedded_device_scenes(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
    if_none_match: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    payload = embedded_scenes_payload(frame)
    etag = f'"{hashlib.sha256(payload).hexdigest()}"'
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers={"ETag": etag})
    return Response(content=payload, media_type="application/json",
                    headers={"ETag": etag})


@api_public.get("/frames/{id:int}/embedded/settings")
async def api_embedded_device_settings(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    return embedded_settings_payload(db, frame)


@api_public.get("/frames/{id:int}/embedded/media")
async def api_embedded_device_media(
    id: int,
    url: str | None = None,
    gallery_category: str | None = None,
    fit: str = "cover",
    output_width: int | None = None,
    output_height: int | None = None,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    if gallery_category:
        if not GALLERY_CATEGORY_RE.match(gallery_category):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid gallery category")
        source_url = f"https://gallery.frameos.net/image?category={gallery_category}"
    else:
        source_url = _validate_embedded_media_url(url or "")
    source = await _fetch_embedded_media_source(source_url)
    frame_width, frame_height = embedded_render_dimensions(frame)
    width, height = embedded_media_output_dimensions(frame_width, frame_height, output_width, output_height)
    fit_mode = "contain" if fit == "contain" else "cover"
    content = await get_running_loop().run_in_executor(
        None, _render_embedded_media, source, width, height, fit_mode
    )
    return Response(
        content=content,
        media_type="image/bmp",
        headers={
            "Cache-Control": "no-store",
            "X-FrameOS-Source-Bytes": str(len(source)),
            "X-FrameOS-Output-Format": EMBEDDED_MEDIA_FORMAT,
            "X-FrameOS-Output-Width": str(width),
            "X-FrameOS-Output-Height": str(height),
            "X-FrameOS-Frame-Width": str(frame_width),
            "X-FrameOS-Frame-Height": str(frame_height),
        },
    )


@api_public.get("/frames/{id:int}/embedded/ota/manifest")
async def api_embedded_device_ota_manifest(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    firmware = latest_embedded_firmware(frame) or {}
    ota_path = firmware.get("otaPath")
    if (firmware.get("status") != "ready" or not isinstance(ota_path, str)
            or not os.path.isfile(ota_path)):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="No OTA image available")
    return {
        "sha256": firmware.get("otaSha256"),
        "size": firmware.get("otaSize"),
        "firmwareVersion": firmware.get("firmwareVersion"),
    }


@api_public.get("/frames/{id:int}/embedded/ota/download")
async def api_embedded_device_ota_download(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    firmware = latest_embedded_firmware(frame) or {}
    ota_path = firmware.get("otaPath")
    if (firmware.get("status") != "ready" or not isinstance(ota_path, str)
            or not os.path.isfile(ota_path)):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="No OTA image available")
    return FileResponse(ota_path, media_type="application/octet-stream",
                        filename=os.path.basename(ota_path))
