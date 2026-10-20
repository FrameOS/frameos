"""The provider protocol's HTTP half: claim tokens, enrollment, service settings.

A frame enrolled here dials this backend's management WebSocket
(app/ws/provider_hub.py) exactly as it would dial FrameOS Cloud's; this file
is the rest of what docs/cloud-frames.md asks of a provider:

- `POST /api/frames/claim-tokens` (owner): "Add frame -> Connect with a claim
  code". A single-use `FRCT_` token the owner hands the device (its setup
  portal, its admin page's Cloud section, an SD card's frameos-cloud.txt),
  with this backend's URL as the provider.
- `POST /api/frames/enroll` (device, unauthenticated): redeem the token with
  the device's own Ed25519 public key; answers the link token, the frame id
  and the socket path. Wire contract: docs/cloud-frames.md "Enrollment".
- `GET /api/frames/{id}/service-settings` (device, Bearer link token): the
  service keys the frame's scenes may read, pulled, never pushed.
  docs/cloud-frames.md "Service settings".
"""
from __future__ import annotations

import hashlib
import json
from http import HTTPStatus
from typing import Any, Optional

from fastapi import Depends, Header, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.apps import get_app_configs
from app.models.frame import Frame, shipped_frame_settings
from app.models.frame_provider import FrameClaimToken, FrameProviderLink
from app.models.log import new_log
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.utils.frame_secrets import websocket_frame_payload
from app.utils.provider_frames import (
    CLAIM_TOKEN_SCOPES,
    CLAIM_TOKEN_TTL,
    LINK_TOKEN_PREFIX,
    SERVICE_SETTINGS_SCOPE,
    WS_PATH,
    apply_hardware_to_frame,
    create_secret_token,
    decode_public_key,
    hash_secret,
    link_for_bearer,
    mint_claim_token,
    mode_for_platform,
    parse_hardware,
    safe_local_origin,
    utcnow,
)
from app.utils.provider_commands import provider_link_changed
from app.utils.rate_limit import hit_rate_limit
from app.utils.request_ip import client_ip_for_request
from app.websockets import publish_message
from arq import ArqRedis as Redis

from . import api_project, api_public

# A device enrolls once; a burst from one address is someone guessing tokens.
ENROLL_LIMIT = 30
ENROLL_WINDOW_SECONDS = 15 * 60
SERVICE_SETTINGS_LIMIT = 120
SERVICE_SETTINGS_WINDOW_SECONDS = 15 * 60

# group -> the fields a device may receive (the cloud's deviceDeliverableFields).
DEVICE_DELIVERABLE_FIELDS: dict[str, frozenset[str]] = {
    "frameOS": frozenset({"apiKey"}),
    "github": frozenset({"api_key"}),
    "homeAssistant": frozenset({"url", "accessToken"}),
    "immich": frozenset({"url", "apiKey"}),
    "openAI": frozenset({"apiKey"}),
    "unsplash": frozenset({"accessKey"}),
}


def _error(error: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": error, **extra}, status_code=status, headers={"cache-control": "no-store"})


# ----------------------------------------------------------------- owner

class ClaimTokenRequest(BaseModel):
    name: Optional[str] = None
    # Re-key this provider frame instead of creating one (a board that lost
    # its keys comes back as the same frame).
    frame_id: Optional[int] = None


@api_project.post("/frames/claim-tokens")
async def create_frame_claim_token(
    data: ClaimTokenRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    project_id = int(request.path_params.get("project_id") or 0)
    if data.frame_id is not None:
        frame = db.get(Frame, int(data.frame_id))
        if frame is None or int(frame.project_id) != project_id:
            return _error("frame_not_found", HTTPStatus.NOT_FOUND)
    token, row = mint_claim_token(db, project_id, frame_id=data.frame_id, name=data.name)
    return {
        "token": token,
        "expires_at": row.expires_at.isoformat() + "Z",
        "ttl_seconds": int(CLAIM_TOKEN_TTL.total_seconds()),
        "frame_id": row.frame_id,
        "ws_path": WS_PATH,
    }


# ---------------------------------------------------------------- device

def _enroll_response(frame: Frame, link: FrameProviderLink, access_token: str) -> JSONResponse:
    return JSONResponse(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "scope": link.scopes,
            "frame_id": str(frame.id),
            "status": link.status,
            "ws_path": WS_PATH,
        },
        headers={"cache-control": "no-store"},
    )


def _new_provider_frame(db: Session, token: FrameClaimToken, name: str, hardware: Optional[dict], origin: Optional[str]) -> Frame:
    from urllib.parse import urlsplit

    platform = (hardware or {}).get("platform")
    mode = mode_for_platform(platform)
    frame = Frame(
        project_id=int(token.project_id),
        name=name,
        mode=mode,
        # Where the device's own admin page is, for the workspace's links;
        # nothing here ever connects to it.
        frame_host=(urlsplit(origin).hostname or "") if origin else "",
        frame_port=(urlsplit(origin).port or 8787) if origin else 8787,
        status="ready",
        scenes=[],
        interval=300,
        scaling_mode="contain",
        rotate=0,
        device="web_only",
        schedule={"events": []},
        embedded={"platform": platform} if mode == "embedded" and isinstance(platform, str) else None,
    )
    apply_hardware_to_frame(frame, hardware)
    db.add(frame)
    db.flush()
    return frame


@api_public.post("/frames/enroll")
async def enroll_provider_frame(
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if await hit_rate_limit(
        redis, "frames:enroll", client_ip_for_request(request) or "unknown",
        limit=ENROLL_LIMIT, window_seconds=ENROLL_WINDOW_SECONDS,
    ):
        return _error("rate_limited", HTTPStatus.TOO_MANY_REQUESTS)
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        return _error("invalid_request", HTTPStatus.BAD_REQUEST)
    if not isinstance(body, dict):
        return _error("invalid_request", HTTPStatus.BAD_REQUEST)

    claim_token = body.get("claim_token")
    if not isinstance(claim_token, str) or not claim_token or len(claim_token) > 256:
        # The device-flow enrollment (a Bearer from /api/device/poll) is the
        # cloud's; this provider links frames by claim token only.
        return _error("invalid_claim_token", HTTPStatus.BAD_REQUEST)
    public_key = body.get("public_key")
    if decode_public_key(public_key) is None:
        return _error("invalid_public_key", HTTPStatus.BAD_REQUEST)
    hardware = parse_hardware(body.get("hardware"))
    version = body.get("frameos_version")
    version = version[:64] if isinstance(version, str) and version else None
    requested_name = body.get("name")
    requested_name = requested_name.strip()[:256] if isinstance(requested_name, str) and requested_name.strip() else None
    origin = safe_local_origin(body.get("local_origin"))

    now = utcnow()
    token = db.query(FrameClaimToken).filter_by(token_hash=hash_secret(claim_token)).first()
    if token is None or token.expires_at < now:
        return _error("invalid_claim_token", HTTPStatus.BAD_REQUEST)

    access_token = create_secret_token(LINK_TOKEN_PREFIX, 40)
    if token.used_at is not None:
        # Idempotent retry: the device lost the response to an enrollment
        # that succeeded. Same token, same key -> the same frame, with a
        # freshly rotated link token. A different key is a different device.
        replayed = db.get(Frame, int(token.used_frame_id)) if token.used_frame_id else None
        link = replayed.provider_link if replayed is not None else None
        if (
            replayed is None
            or link is None
            or token.used_public_key != public_key
            or link.public_key != public_key
            or link.status != "active"
        ):
            return _error("invalid_claim_token", HTTPStatus.BAD_REQUEST)
        frame = replayed
        link.token_hash = hash_secret(access_token)
        db.commit()
        await provider_link_changed(redis, int(frame.id))
        return _enroll_response(frame, link, access_token)

    scopes = " ".join(CLAIM_TOKEN_SCOPES)
    created = False
    if token.frame_id is not None:
        # Re-enrollment: a token minted FOR a frame re-keys it in place. Only
        # the device key, the token and what the device reports move; the
        # frame's scenes, settings, logs and name stay.
        bound = db.get(Frame, int(token.frame_id))
        if bound is None or int(bound.project_id) != int(token.project_id):
            return _error("invalid_claim_token", HTTPStatus.BAD_REQUEST)
        frame = bound
        link = frame.provider_link
        if link is None:
            link = FrameProviderLink(project_id=int(frame.project_id), frame_id=int(frame.id))
            frame.provider_link = link
        link.public_key = public_key
        link.token_hash = hash_secret(access_token)
        link.scopes = scopes
        link.status = "active"
        link.revoked_at = None
        link.connected = False
        link.session_id = None
    else:
        frame = _new_provider_frame(db, token, requested_name or token.name or "FrameOS", hardware, origin)
        link = FrameProviderLink(
            project_id=int(frame.project_id),
            frame_id=int(frame.id),
            public_key=public_key,
            token_hash=hash_secret(access_token),
            scopes=scopes,
            status="active",
            created_at=now,
            connected=False,
        )
        frame.provider_link = link
        created = True
    if hardware is not None:
        link.hardware = hardware
        apply_hardware_to_frame(frame, hardware)
    if version:
        link.frameos_version = version
    if origin and not link.local_origin:
        link.local_origin = origin
    token.used_at = now
    token.used_public_key = public_key
    token.used_frame_id = int(frame.id)
    db.commit()
    db.refresh(frame)

    payload = websocket_frame_payload(frame.to_dict())
    await publish_message(redis, "new_frame" if created else "update_frame", payload)
    await new_log(
        db, redis, int(frame.id), "welcome",
        f'The frame "{frame.name}" enrolled with this backend as its provider'
        + ("" if created else " again, with a new device key"),
    )
    if not created:
        # A socket still open under the old key is a different device now.
        await provider_link_changed(redis, int(frame.id))
    return _enroll_response(frame, link, access_token)


def _canonical_json(value: Any) -> str:
    """The cloud's canonicalJson: keys sorted at every level, no whitespace,
    non-ASCII kept as is — the same bytes, so the same ETag."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def service_settings_payload(db: Session, frame: Frame) -> dict[str, Any]:
    """What the frame may receive: every group its scenes are granted (the
    owner's scenes declare theirs, store scenes get what the owner granted —
    shipped_frame_settings, the same walk frame.json uses), narrowed to the
    six device-deliverable groups and their fields."""
    shipped = shipped_frame_settings(frame, get_settings_dict(db, project_id=int(frame.project_id)), get_app_configs())
    groups = sorted(group for group in shipped if group in DEVICE_DELIVERABLE_FIELDS)
    settings: dict[str, dict[str, str]] = {}
    for group in groups:
        stored = shipped.get(group)
        if not isinstance(stored, dict):
            continue
        fields = {
            field: value
            for field, value in stored.items()
            if field in DEVICE_DELIVERABLE_FIELDS[group] and isinstance(value, str) and value != ""
        }
        if fields:
            settings[group] = fields
    return {"settings": settings, "groups": groups}


@api_public.get("/frames/{id:int}/service-settings")
async def provider_frame_service_settings(
    id: int,
    request: Request,
    authorization: Optional[str] = Header(None),
    if_none_match: Optional[str] = Header(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if await hit_rate_limit(
        redis, "frames:service-settings", client_ip_for_request(request) or "unknown",
        limit=SERVICE_SETTINGS_LIMIT, window_seconds=SERVICE_SETTINGS_WINDOW_SECONDS,
    ):
        return _error("rate_limited", HTTPStatus.TOO_MANY_REQUESTS)
    link = link_for_bearer(db, authorization)
    if link is None:
        return _error("invalid_link_token", HTTPStatus.UNAUTHORIZED)
    frame = link.frame
    if frame is None:
        return _error("frame_not_enrolled", HTTPStatus.UNAUTHORIZED)
    if int(frame.id) != id:
        return _error("frame_mismatch", HTTPStatus.FORBIDDEN)
    if SERVICE_SETTINGS_SCOPE not in link.scope_list():
        return _error("insufficient_scope", HTTPStatus.FORBIDDEN)
    body = _canonical_json(service_settings_payload(db, frame))
    etag = f'"{hashlib.sha256(body.encode("utf-8")).hexdigest()}"'
    if if_none_match == etag:
        return Response(status_code=HTTPStatus.NOT_MODIFIED, headers={"cache-control": "no-store", "etag": etag})
    return Response(
        content=body,
        media_type="application/json",
        headers={"cache-control": "no-store", "etag": etag},
    )



# ---------------------------------------------------------- firmware (ESP32)

def _device_link_or_error(db: Session, id: int, authorization: Optional[str]) -> FrameProviderLink | JSONResponse:
    link = link_for_bearer(db, authorization)
    if link is None:
        return _error("invalid_link_token", HTTPStatus.UNAUTHORIZED)
    if link.frame is None:
        return _error("frame_not_enrolled", HTTPStatus.UNAUTHORIZED)
    if int(link.frame_id) != id:
        return _error("frame_mismatch", HTTPStatus.FORBIDDEN)
    return link


def _ota_platform(platform: Optional[str]) -> Optional[str]:
    import re

    return platform if isinstance(platform, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", platform) else None


@api_public.get("/frames/{id:int}/firmware/manifest")
async def provider_frame_firmware_manifest(
    id: int,
    platform: Optional[str] = None,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """The signed release's OTA manifest for an ESP32 on its management
    socket — the path the firmware's cloud updater asks (fos_ota.c
    cloud_ota_run), relayed from the GitHub release like
    `/embedded/ota/manifest`. The device verifies the minisign signature
    itself; nothing here can make it install an image the release key did
    not sign."""
    from app.api.firmware_release import latest_release_ota_manifest

    found = _device_link_or_error(db, id, authorization)
    if isinstance(found, JSONResponse):
        return found
    platform = _ota_platform(platform)
    if platform is None:
        return _error("invalid_platform", HTTPStatus.BAD_REQUEST)
    manifest = await latest_release_ota_manifest(platform, f"/api/frames/{id}/firmware/download?platform={platform}")
    return JSONResponse(manifest, headers={"cache-control": "no-store"})


@api_public.head("/frames/{id:int}/firmware/download")
@api_public.get("/frames/{id:int}/firmware/download")
async def provider_frame_firmware_download(
    id: int,
    platform: Optional[str] = None,
    authorization: Optional[str] = Header(None),
    range: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    from app.api.firmware_release import stream_latest_release_ota_image

    found = _device_link_or_error(db, id, authorization)
    if isinstance(found, JSONResponse):
        return found
    platform = _ota_platform(platform)
    if platform is None:
        return _error("invalid_platform", HTTPStatus.BAD_REQUEST)
    return await stream_latest_release_ota_image(platform, range_header=range)
