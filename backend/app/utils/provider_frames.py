"""Frames this backend manages as their provider: the shared helpers.

A provider frame enrolled with a claim token against this backend
(docs/cloud-frames.md, "Enrollment") and dials its management WebSocket.
Everything the backend does to such a frame is a contract verb on its
command queue (app/utils/frame_commands.py): no SSH, no Remote, no admin
login, no LAN request. The models are app/models/frame_provider.py; the
socket is app/ws/provider_hub.py; the device's HTTP routes (enroll, service
settings) are app/api/provider_device.py; turning backend actions into verbs
is app/utils/provider_commands.py.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.frame_provider import FrameClaimToken, FrameProviderLink

CLAIM_TOKEN_PREFIX = "FRCT"
LINK_TOKEN_PREFIX = "fb_link"
# Single use, short-lived: the cloud's claim tokens keep 24 hours by default.
CLAIM_TOKEN_TTL = timedelta(hours=24)
WS_PATH = "/api/frames/ws"

FRAME_MANAGED_SCOPE = "frame:managed"
SERVICE_SETTINGS_SCOPE = "settings:services"
TELEMETRY_LOGS_SCOPE = "telemetry:logs"
TELEMETRY_METRICS_SCOPE = "telemetry:metrics"
# What a claim-token enrollment grants, and therefore what the enrollment
# response's `scope` lists in full: the device gates its own telemetry loops
# on that string (the cloud's claimTokenGrantedScopes).
CLAIM_TOKEN_SCOPES: tuple[str, ...] = (
    FRAME_MANAGED_SCOPE,
    SERVICE_SETTINGS_SCOPE,
    TELEMETRY_LOGS_SCOPE,
    TELEMETRY_METRICS_SCOPE,
)

MAX_HARDWARE_JSON_BYTES = 4096


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_secret(secret: str) -> str:
    """The cloud's hashSecret: base64url SHA-256, unpadded."""
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def create_secret_token(prefix: str, byte_length: int = 32) -> str:
    raw = base64.urlsafe_b64encode(secrets.token_bytes(byte_length)).rstrip(b"=").decode("ascii")
    return f"{prefix}_{raw}"


def decode_public_key(value: Any) -> Optional[bytes]:
    """The raw 32-byte Ed25519 key of an enrollment's `public_key`, or None."""
    if not isinstance(value, str) or not value or len(value) > 128:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        return None
    return raw if len(raw) == 32 else None


# ------------------------------------------------------------------ frames

def provider_link(frame: Any) -> Optional[FrameProviderLink]:
    from app.models.frame_provider import frame_provider_link

    return frame_provider_link(frame)


def is_provider_frame(frame: Any) -> bool:
    """Is this backend the frame's provider? Then every action is a verb on
    its command queue and nothing else reaches it. A revoked link still
    counts: the frame is gone from the socket, not back on SSH."""
    return provider_link(frame) is not None


def provider_profile(frame: Any) -> str:
    """Which device profile of the contract the frame runs: `esp32` for the
    firmware, `linux` for everything else (docs/cloud-frames.md, "Device
    profiles"). From the hardware the device reported, then its mode."""
    link = provider_link(frame)
    hardware = link.hardware if link is not None and isinstance(link.hardware, dict) else {}
    platform = str(hardware.get("platform") or "").lower()
    if platform.startswith("esp32"):
        return "esp32"
    if platform:
        return "linux"
    return "esp32" if (getattr(frame, "mode", None) or "") == "embedded" else "linux"


def provider_reported_version(frame: Any) -> Optional[str]:
    link = provider_link(frame)
    version = link.frameos_version if link is not None else None
    return version if isinstance(version, str) and version else None


def mode_for_platform(platform: Any) -> str:
    """frame.mode for a device reporting `hardware.platform` (frame.json's
    deployment mode on Linux, the chip family on the firmware)."""
    value = str(platform or "").lower()
    if value.startswith("esp32"):
        return "embedded"
    if value == "buildroot":
        return "buildroot"
    return "rpios"


def parse_hardware(value: Any) -> Optional[dict[str, Any]]:
    import json

    if not isinstance(value, dict):
        return None
    try:
        encoded = json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return None
    return value if len(encoded.encode("utf-8")) <= MAX_HARDWARE_JSON_BYTES else None


def safe_local_origin(value: Any) -> Optional[str]:
    """A device's `local_origin`, kept only when it is an http(s) origin on
    the local network (the cloud's safeLocalOrigin): a value that fails is
    dropped, never refused."""
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    host = parts.hostname.lower()
    local = host == "localhost" or host.endswith(".local") or host.endswith(".localhost")
    if not local:
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            return None
        local = address.is_private or address.is_loopback or address.is_link_local or address in _CGNAT
    if not local:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    netloc = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{netloc}{f':{port}' if port else ''}"


_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def mint_claim_token(
    db: Session,
    project_id: int,
    *,
    frame_id: Optional[int] = None,
    name: Optional[str] = None,
    ttl: timedelta = CLAIM_TOKEN_TTL,
    now: Optional[datetime] = None,
) -> tuple[str, FrameClaimToken]:
    """A fresh single-use `FRCT_` token. Only its hash is stored. Commits."""
    now = now or utcnow()
    token = create_secret_token(CLAIM_TOKEN_PREFIX, 24)
    row = FrameClaimToken(
        project_id=int(project_id),
        token_hash=hash_secret(token),
        frame_id=frame_id,
        name=(name or "").strip()[:256] or None,
        created_at=now,
        expires_at=now + ttl,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return token, row


def link_for_bearer(db: Session, authorization: Optional[str]) -> Optional[FrameProviderLink]:
    """The live link a device's `Authorization: Bearer <link token>` names."""
    if not authorization:
        return None
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        return None
    link = db.query(FrameProviderLink).filter_by(token_hash=hash_secret(parts[1])).first()
    if link is None or link.status != "active" or link.revoked_at is not None:
        return None
    return link


def frame_dimensions_from_hardware(hardware: dict[str, Any]) -> tuple[Optional[int], Optional[int]]:
    def as_int(value: Any) -> Optional[int]:
        return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 100_000 else None

    return as_int(hardware.get("width")), as_int(hardware.get("height"))


def apply_hardware_to_frame(frame: Frame, hardware: Optional[dict[str, Any]]) -> None:
    """What the device says about its panel is the truth for the row: the
    driver, the size and the color mode the workspace draws and previews
    with. Only fields the device sent are touched."""
    if not hardware:
        return
    width, height = frame_dimensions_from_hardware(hardware)
    if width and height:
        frame.width = width
        frame.height = height
    device = hardware.get("device")
    if isinstance(device, str) and device and len(device) <= 256:
        frame.device = device
    color = hardware.get("color")
    if isinstance(color, str) and color and len(color) <= 256:
        frame.color = color



def scene_snapshot_asset_path(scene_id: str) -> str:
    """Where the device keeps its snapshot of a scene, relative to its assets
    directory (frameos/src/frameos/scenes.nim sceneImagePath; the cloud's
    sceneSnapshotAssetPath): readable with `asset_get`, never writable."""
    public_id = scene_id[len("uploaded/"):] if scene_id.startswith("uploaded/") else scene_id
    safe = "".join(ch if (ch.isascii() and ch.isalnum()) or ch in "-_." else "_" for ch in public_id)
    safe = safe.strip("_.-") or "scene"
    digest = hashlib.md5(public_id.encode("utf-8")).hexdigest()
    return f".frameos/scene_images/{safe[:64]}-{digest}.png"
