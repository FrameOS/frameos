"""Device-facing endpoints for embedded (ESP32) frames.

The microcontroller authenticates with its ``server_api_key`` as a Bearer
token (same scheme as ``/api/log``). Three endpoints:

- ``GET /api/frames/{id}/embedded/render`` — the M1 thin-client bitmap. The
  backend's per-frame scene rendering for embedded is intentionally a stub
  (scenes render on-device via the Nim runtime); this returns a placeholder
  card dithered and packed in the panel's wire format.
- ``GET /api/frames/{id}/embedded/ota/manifest`` — sha256/size of the latest
  OTA app image so the device can decide whether to update.
- ``GET /api/frames/{id}/embedded/ota/download`` — the OTA app image
  (``frameos_esp32.bin``, not the merged flash image).
- ``GET /api/frames/{id}/embedded/scenes`` — the frame's scenes as a JSON
  array (M3 interpreted scenes: QuickJS + AOT app library on-device). The
  ETag is the payload's sha256; devices poll with ``If-None-Match`` and get
  304 when nothing changed, so hot scene updates need no reflash.

Wire format for /render ("FOSB"): magic ``FOSB``, version u8 (1), pixel
format u8 (1 = packed 1bpp white=1 MSB-first), width u16le, height u16le,
reserved u16, then ``ceil(width/8)*height`` payload bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
from datetime import datetime, timezone
from http import HTTPStatus

from fastapi import Depends, Header, HTTPException
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.drivers.devices import device_dimensions
from app.models.frame import Frame
from app.tasks.embedded_firmware import latest_embedded_firmware
from . import api_public

FOSB_FORMAT_1BPP = 1
DEFAULT_WIDTH = 800
DEFAULT_HEIGHT = 480


def _embedded_frame_from_bearer(db: Session, frame_id: int, authorization: str | None) -> Frame:
    if not authorization:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    parts = authorization.split(" ")
    if len(parts) != 2:
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


def render_embedded_placeholder(frame: Frame, width: int, height: int) -> bytes:
    """Stub render: a readable placeholder card, dithered to 1bpp.

    Real scene rendering happens on-device (Nim runtime). This exists so the
    thin-client mode has something correct to fetch end to end.
    """
    from PIL import Image, ImageDraw

    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    draw.rectangle([4, 4, width - 5, height - 5], outline=0, width=3)
    # grayscale ramp to exercise the dithering
    bar_width = max(1, (width - 48) // 16)
    for i in range(16):
        shade = 255 - i * 17
        draw.rectangle([24 + i * bar_width, 24, 24 + (i + 1) * bar_width, 64], fill=shade)
    name = frame.name or f"Frame {frame.id}"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    draw.text((32, height * 0.30), "FrameOS", fill=0)
    draw.text((32, height * 0.40), name, fill=0)
    draw.text((32, height * 0.50), f"Backend-rendered placeholder · {stamp}", fill=0)
    draw.text((32, height * 0.60), "Scenes render on-device in local mode", fill=0)

    # PIL "1" packs rows MSB-first, white=1 — exactly the panel format
    return image.convert("1").tobytes()


def fosb_payload(width: int, height: int, packed: bytes) -> bytes:
    header = b"FOSB" + struct.pack("<BBHHH", 1, FOSB_FORMAT_1BPP, width, height, 0)
    return header + packed


@api_public.get("/frames/{id:int}/embedded/render")
async def api_embedded_device_render(
    id: int,
    db: Session = Depends(get_db),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    width, height = embedded_render_dimensions(frame)
    packed = render_embedded_placeholder(frame, width, height)
    expected = ((width + 7) // 8) * height
    if len(packed) != expected:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                            detail=f"packed buffer {len(packed)} != expected {expected}")
    return Response(content=fosb_payload(width, height, packed),
                    media_type="application/octet-stream")


def embedded_scenes_payload(frame: Frame) -> bytes:
    """The frame's scenes as the JSON array the on-device interpreter loads.

    Embedded frames run every scene interpreted (there is no on-device
    compiler), so unlike Linux fast-deploy this does not filter on
    ``settings.execution``.
    """
    scenes = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    return json.dumps(scenes, separators=(",", ":"), sort_keys=True).encode("utf-8")


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
