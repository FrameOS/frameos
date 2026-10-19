"""Short-lived tokens for the in-browser live preview's HTTP proxy.

The wasm preview worker sends a scene's CORS-blocked fetches to
`scene_preview_proxy`. It used to ride the app's session cookie, which a
worker moved to an opaque origin cannot send (docs/security-todo.md,
"Preview worker isolation"). The page mints a token with its session
instead, hands it to the worker, and the worker sends it in the
`X-FrameOS-Preview-Token` header.

A token is `pp1.<project>.<frame>.<user>.<expires_at>.<hmac>`: it names one
frame of one project and the user who asked for it, and stops working after
`PREVIEW_PROXY_TOKEN_TTL_SECONDS`. The key is derived from SECRET_KEY for this
purpose alone, so a login JWT never verifies as a preview token, nor the
other way round.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass

from app.config import config

PREVIEW_PROXY_TOKEN_HEADER = "X-FrameOS-Preview-Token"
# Long enough for a preview session between two refreshes (the page mints a
# new one well before this runs out), short enough that a token lifted from
# a worker is not a standing credential.
PREVIEW_PROXY_TOKEN_TTL_SECONDS = 15 * 60

_TOKEN_VERSION = "pp1"


@dataclass(frozen=True)
class PreviewProxyGrant:
    project_id: int
    frame_id: int
    # None when it was minted without a user (Home Assistant ingress).
    user_id: int | None
    expires_at: int


def _signing_key() -> bytes:
    return hmac.new(
        str(config.SECRET_KEY).encode("utf-8"),
        b"frameos-preview-proxy-token",
        hashlib.sha256,
    ).digest()


def _signature(project_id: int, frame_id: int, user_id: int, expires_at: int) -> str:
    payload = f"{_TOKEN_VERSION}:{project_id}:{frame_id}:{user_id}:{expires_at}"
    return hmac.new(_signing_key(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def mint_preview_proxy_token(
    *,
    project_id: int,
    frame_id: int,
    user_id: int | None,
    now: float | None = None,
) -> tuple[str, int]:
    """Returns the token and the unix time it expires at."""
    expires_at = int(time.time() if now is None else now) + PREVIEW_PROXY_TOKEN_TTL_SECONDS
    user = int(user_id or 0)
    signature = _signature(project_id, frame_id, user, expires_at)
    return f"{_TOKEN_VERSION}.{project_id}.{frame_id}.{user}.{expires_at}.{signature}", expires_at


def read_preview_proxy_token(token: str, *, now: float | None = None) -> PreviewProxyGrant | None:
    """The grant a token carries, or None when it is malformed, tampered
    with, expired, or claims to last longer than any token is minted for."""
    parts = (token or "").strip().split(".")
    if len(parts) != 6 or parts[0] != _TOKEN_VERSION:
        return None
    _, project_text, frame_text, user_text, expires_text, signature = parts
    if not all(text.isdigit() for text in (project_text, frame_text, user_text, expires_text)) or not signature:
        return None
    project_id, frame_id, user_id, expires_at = (
        int(project_text),
        int(frame_text),
        int(user_text),
        int(expires_text),
    )
    current = time.time() if now is None else now
    if expires_at < current or expires_at > current + PREVIEW_PROXY_TOKEN_TTL_SECONDS:
        return None
    if not secrets.compare_digest(_signature(project_id, frame_id, user_id, expires_at), signature):
        return None
    return PreviewProxyGrant(
        project_id=project_id,
        frame_id=frame_id,
        user_id=user_id or None,
        expires_at=expires_at,
    )
