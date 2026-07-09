"""Linking this FrameOS installation to a FrameOS Cloud provider.

Phase 0 of CLOUD-TODO.md: establish and hold a scoped link token via the
OAuth 2.0 Device Authorization Grant. Phase 1: cloud login — a browser
handoff that signs local users in with their FrameOS Cloud account, plus the
first-run setup flow that can create the first user from a cloud principal.
The protocol is documented in docs/cloud-link.md; the provider URL is
user-editable so any compatible server works. All connections are
outbound-only, initiated here.
"""
from __future__ import annotations

import datetime
import json
import secrets
from http import HTTPStatus

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.api.auth import ACCESS_TOKEN_EXPIRE_MINUTES, _should_use_secure_cookie, get_current_user
from app.database import get_db
from app.models.cloud import CloudBackendLink, CloudIdentity, current_cloud_backend_link, link_is_expired
from app.models.user import User
from app.redis import get_redis
from app.schemas.cloud import (
    CloudConnectRequest,
    CloudFeaturesRequest,
    CloudLocalFallbackRequest,
    CloudLoginOptionsResponse,
    CloudLoginStartRequest,
    CloudLoginStartResponse,
    CloudProviderUpdateRequest,
    CloudStatusResponse,
)
from app.utils import cloud_link as cloud
from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value
from app.utils.versions import current_frameos_version

from . import api_open, api_user

CLOUD_LOGIN_STATE_PREFIX = "cloud_login_state:"
CLOUD_LOGIN_STATE_TTL_SECONDS = 600

# Scopes a link may request; must stay in sync with the table in CLOUD-TODO.md
# and docs/cloud-link.md.
KNOWN_SCOPES = {
    "backend:link",
    "backend:read",
    "auth:login",
    "store:read",
    "store:publish",
    "gallery:read",
    "backup:templates",
    "backup:frames",
    "backup:assets",
    "remote:access",
    "telemetry:logs",
    "telemetry:metrics",
}


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


async def _nudge_cloud_sync() -> None:
    """Wake the worker's cloud sync service (best effort)."""
    try:
        from app.cloud import CLOUD_SYNC_CHANNEL
        from app.redis import get_shared_redis

        await get_shared_redis().publish(CLOUD_SYNC_CHANNEL, json.dumps({"event": "sync_now"}))
    except Exception:  # noqa: BLE001
        pass


def _request_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}".rstrip("/")


def _effective_provider_url(link: CloudBackendLink | None) -> str | None:
    if link is not None and link.provider_url:
        return link.provider_url
    return cloud.default_cloud_provider_url()


def _clear_upgrade(link: CloudBackendLink, poll_error: str | None = None) -> None:
    """Forget a pending feature-change approval; the link itself stays up."""
    link.device_code = None
    link.user_code = None
    link.verification_uri = None
    link.verification_uri_complete = None
    link.expires_at = None
    link.poll_error = poll_error
    link.updated_at = _now()


def _upgrade_pending(link: CloudBackendLink | None) -> bool:
    return link is not None and link.status == "connected" and bool(link.device_code)


def _status_payload(db: Session, link: CloudBackendLink | None, user: User | None = None) -> dict:
    default_url = cloud.default_cloud_provider_url()
    enabled = default_url is not None
    if link is not None and link_is_expired(link, _now()):
        _reset_link(link, poll_error="expired")
        db.commit()
    if _upgrade_pending(link) and link.expires_at is not None and link.expires_at <= _now():
        _clear_upgrade(link, poll_error="expired")
        db.commit()

    status = link.status if link else "disconnected"
    payload: dict = {
        "enabled": enabled,
        "provider_url": _effective_provider_url(link),
        "default_provider_url": default_url,
        "status": status,
        "can_edit_provider": status == "disconnected",
        "poll_error": link.poll_error if link else None,
        "local_fallback_enabled": link.local_fallback_enabled if link else True,
        "connection": None,
        "link": None,
        "identity": _identity_payload(db, user),
    }
    if link is None:
        return payload
    if status == "connecting":
        payload["connection"] = {
            "user_code": link.user_code,
            "verification_uri": link.verification_uri,
            "verification_uri_complete": link.verification_uri_complete,
            "expires_at": link.expires_at.isoformat() if link.expires_at else None,
            "interval_seconds": link.interval_seconds,
        }
    if status == "connected":
        payload["link"] = {
            "linked_client_id": link.linked_client_id,
            "scopes": link.scopes,
            "account_id": link.cloud_account_id,
            "account_email": link.cloud_account_email,
            "connected_at": link.updated_at.isoformat() if link.updated_at else None,
            "last_inventory_sync_at": link.last_inventory_sync_at.isoformat()
            if link.last_inventory_sync_at
            else None,
        }
        # A pending feature change awaiting owner approval on the provider.
        if link.device_code:
            payload["upgrade"] = {
                "user_code": link.user_code,
                "verification_uri": link.verification_uri,
                "verification_uri_complete": link.verification_uri_complete,
                "expires_at": link.expires_at.isoformat() if link.expires_at else None,
                "interval_seconds": link.interval_seconds,
            }
    return payload


def _identity_payload(db: Session, user: User | None) -> dict | None:
    """The current user's linked cloud identity, for the settings UI."""
    if user is None:
        return None
    identity = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.user_id == user.id)
        .order_by(CloudIdentity.id.desc())
        .first()
    )
    if identity is None:
        return None
    return {
        "cloud_account_id": identity.cloud_account_id,
        "email": identity.email,
        "name": identity.name,
        "provider_url": identity.provider_url,
        "last_login_at": identity.last_login_at.isoformat() if identity.last_login_at else None,
    }


def _link_has_scope(link: CloudBackendLink | None, scope: str) -> bool:
    return link is not None and scope in link.scopes


def _connected_link(db: Session) -> CloudBackendLink | None:
    link = current_cloud_backend_link(db)
    if link is None or link.status != "connected":
        return None
    return link


def _reset_link(link: CloudBackendLink, poll_error: str | None = None) -> None:
    link.status = "disconnected"
    link.device_code = None
    link.user_code = None
    link.verification_uri = None
    link.verification_uri_complete = None
    link.expires_at = None
    link.access_token = None
    link.token_reference = None
    link.linked_client_id = None
    link.cloud_account_id = None
    link.cloud_account_email = None
    link.scope = None
    link.poll_error = poll_error
    link.revoked_at = None
    # Never leave an install without a way to log in: losing the cloud link
    # always re-enables local password login.
    link.local_fallback_enabled = True
    link.updated_at = _now()


@api_user.get("/cloud/status", response_model=CloudStatusResponse)
async def get_cloud_status(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    return _status_payload(db, current_cloud_backend_link(db), current_user)


async def _update_provider(data: CloudProviderUpdateRequest, db: Session) -> dict:
    try:
        provider_url = cloud.normalize_cloud_provider_url(data.provider_url)
    except ValueError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc))
    if provider_url is None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Enter a server URL")

    link = current_cloud_backend_link(db)
    if link is not None and link.status != "disconnected":
        raise HTTPException(
            status_code=HTTPStatus.CONFLICT,
            detail="Disconnect from FrameOS Cloud before changing the server URL",
        )
    if link is None:
        link = CloudBackendLink(provider_url=provider_url, status="disconnected")
        db.add(link)
    else:
        link.provider_url = provider_url
        link.poll_error = None
        link.updated_at = _now()
    db.commit()
    return _status_payload(db, link)


@api_user.post("/cloud/provider", response_model=CloudStatusResponse)
async def set_cloud_provider(data: CloudProviderUpdateRequest, db: Session = Depends(get_db)):
    return await _update_provider(data, db)


async def _start_connect(request: Request, data: CloudConnectRequest, db: Session) -> dict:
    link = current_cloud_backend_link(db)
    if link is not None and link.status == "connected":
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="Already connected to FrameOS Cloud")

    try:
        provider_url = (
            cloud.normalize_cloud_provider_url(data.provider_url)
            if data.provider_url
            else _effective_provider_url(link)
        )
    except ValueError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc))
    if provider_url is None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="FrameOS Cloud is disabled on this install")

    scopes = [s for s in (data.scopes or cloud.DEFAULT_LINK_SCOPES) if s in KNOWN_SCOPES]
    if not scopes:
        scopes = list(cloud.DEFAULT_LINK_SCOPES)

    origin = _request_origin(request)
    start_payload = {
        "public_display_name": f"FrameOS backend ({origin})",
        "local_origin": origin,
        "reported_frameos_version": current_frameos_version(),
        "capabilities": {"localFallback": True},
        "client_kind": "backend",
        "scopes": scopes,
    }
    try:
        status_code, response = await cloud.device_start(provider_url, start_payload)
    except Exception as exc:  # noqa: BLE001 — network errors become a 502 with the cause
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {provider_url}: {exc}"
        ) from exc
    if status_code != 200 or not response.get("device_code"):
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud rejected the request: {detail}")

    if link is None:
        link = CloudBackendLink(provider_url=provider_url)
        db.add(link)
    _reset_link(link)
    link.provider_url = provider_url
    link.status = "connecting"
    link.public_display_name = start_payload["public_display_name"]
    link.local_origin = origin
    link.device_code = response["device_code"]
    link.user_code = response.get("user_code")
    link.verification_uri = response.get("verification_uri")
    link.verification_uri_complete = response.get("verification_uri_complete")
    link.interval_seconds = int(response.get("interval") or 5)
    link.scope = " ".join(scopes)
    expires_in = response.get("expires_in")
    if expires_in:
        link.expires_at = _now() + datetime.timedelta(seconds=int(expires_in))
    db.commit()
    return _status_payload(db, link)


@api_user.post("/cloud/connect", response_model=CloudStatusResponse)
async def connect_cloud(request: Request, data: CloudConnectRequest, db: Session = Depends(get_db)):
    return await _start_connect(request, data, db)


async def _poll_upgrade(db: Session, link: CloudBackendLink) -> dict:
    """One poll step for a pending feature change on a connected link."""
    try:
        status_code, response = await cloud.device_poll(link.provider_url, link.device_code)
    except Exception:  # noqa: BLE001
        link.poll_error = "network_error"
        db.commit()
        return _status_payload(db, link)

    error = response.get("error")
    if error == "authorization_pending":
        link.poll_error = None
        db.commit()
        return _status_payload(db, link)
    if status_code == 200 and response.get("scope") and not response.get("access_token"):
        link.scope = response["scope"]
        _clear_upgrade(link)
        db.commit()
        await _nudge_cloud_sync()
        return _status_payload(db, link)

    # denied / expired / anything unexpected: drop the pending change, keep the link
    _clear_upgrade(link, poll_error=error or f"unexpected status {status_code}")
    db.commit()
    return _status_payload(db, link)


async def _poll_link(db: Session, user: User | None = None) -> dict:
    link = current_cloud_backend_link(db)
    if _upgrade_pending(link):
        return await _poll_upgrade(db, link)
    if link is None or link.status != "connecting" or not link.device_code:
        return _status_payload(db, link, user)

    try:
        status_code, response = await cloud.device_poll(link.provider_url, link.device_code)
    except Exception:  # noqa: BLE001 — transient network errors keep the flow alive
        link.poll_error = "network_error"
        db.commit()
        return _status_payload(db, link)

    error = response.get("error")
    if error == "authorization_pending":
        link.poll_error = None
        db.commit()
        return _status_payload(db, link)
    if status_code == 200 and response.get("access_token"):
        link.status = "connected"
        link.access_token = cloud.encrypt_cloud_secret(response["access_token"])
        link.token_reference = response.get("token_reference")
        link.linked_client_id = response.get("linked_client_id")
        if response.get("scope"):
            link.scope = response["scope"]
        link.device_code = None
        link.user_code = None
        link.verification_uri = None
        link.verification_uri_complete = None
        link.expires_at = None
        link.poll_error = None
        link.updated_at = _now()
        db.commit()
        await _sync_after_connect(db, link, response["access_token"])
        # The cloud account that approved the link IS the person connecting:
        # map it to the local user right away so cloud login works without a
        # separate "link my account" step.
        _auto_link_identity(db, user, link, response.get("approved_by"))
        await _nudge_cloud_sync()
        return _status_payload(db, link, user)

    # denied / expired / anything else: back to square one with the reason kept
    _reset_link(link, poll_error=error or f"unexpected status {status_code}")
    db.commit()
    return _status_payload(db, link, user)


def _auto_link_identity(db: Session, user: User | None, link: CloudBackendLink, approved_by) -> None:
    if user is None or not isinstance(approved_by, dict):
        return
    issuer = approved_by.get("provider_issuer")
    subject = str(approved_by.get("provider_subject") or approved_by.get("sub") or "")
    if not issuer or not subject:
        return
    existing = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.provider_issuer == issuer, CloudIdentity.provider_subject == subject)
        .first()
    )
    if existing is not None and existing.user_id != user.id:
        # Someone else already owns this cloud identity locally; never steal it.
        return
    _upsert_cloud_identity(db, user, link, issuer, approved_by)
    db.commit()


@api_user.post("/cloud/poll", response_model=CloudStatusResponse)
async def poll_cloud(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    return await _poll_link(db, current_user)


async def _sync_after_connect(db: Session, link: CloudBackendLink, access_token: str) -> None:
    """Best effort: report inventory and learn which account owns us."""
    try:
        status_code, _ = await cloud.backend_inventory(
            link.provider_url,
            access_token,
            {
                "reported_frameos_version": current_frameos_version(),
                "capabilities": {"localFallback": True},
                "health": {"status": "ok"},
            },
        )
        if status_code == 200:
            link.last_inventory_sync_at = _now()
    except Exception:  # noqa: BLE001
        pass
    try:
        status_code, response = await cloud.backend_grants(link.provider_url, access_token)
        if status_code == 200:
            grants = response.get("grants") or []
            owner = next((g for g in grants if isinstance(g, dict) and g.get("role") == "owner"), None)
            if owner:
                link.cloud_account_id = owner.get("account_id")
                link.cloud_account_email = owner.get("account_email")
            link.last_grant_sync_at = _now()
    except Exception:  # noqa: BLE001
        pass
    db.commit()


@api_user.post("/cloud/disconnect", response_model=CloudStatusResponse)
async def disconnect_cloud(db: Session = Depends(get_db)):
    link = current_cloud_backend_link(db)
    if link is None:
        return _status_payload(db, None)

    access_token = cloud.decrypt_cloud_secret(link.access_token)
    if link.status == "connected" and access_token:
        try:
            await cloud.backend_unlink(link.provider_url, access_token)
        except Exception:  # noqa: BLE001 — local disconnect must work while the cloud is down
            pass
    _reset_link(link)
    db.commit()
    return _status_payload(db, link)


# ---- first-run setup (no users yet) ------------------------------------------
#
# A fresh install has no user to log in with, but the setup screen must be able
# to link to the cloud so the first user can be created from a cloud account
# (and Phase 3 backups restored). Anyone who can reach a fresh install can
# already claim it through the open /api/signup, so these carry the same trust.


def _require_setup_mode(db: Session) -> None:
    if db.query(User).first() is not None:
        raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail="Setup is complete; log in first")


@api_open.get("/cloud/setup/status", response_model=CloudStatusResponse)
async def setup_cloud_status(db: Session = Depends(get_db)):
    _require_setup_mode(db)
    return _status_payload(db, current_cloud_backend_link(db))


@api_open.post("/cloud/setup/provider", response_model=CloudStatusResponse)
async def setup_cloud_provider(data: CloudProviderUpdateRequest, db: Session = Depends(get_db)):
    _require_setup_mode(db)
    return await _update_provider(data, db)


@api_open.post("/cloud/setup/connect", response_model=CloudStatusResponse)
async def setup_cloud_connect(request: Request, data: CloudConnectRequest, db: Session = Depends(get_db)):
    _require_setup_mode(db)
    return await _start_connect(request, data, db)


@api_open.post("/cloud/setup/poll", response_model=CloudStatusResponse)
async def setup_cloud_poll(db: Session = Depends(get_db)):
    _require_setup_mode(db)
    return await _poll_link(db)


@api_open.post("/cloud/setup/disconnect", response_model=CloudStatusResponse)
async def setup_cloud_disconnect(db: Session = Depends(get_db)):
    _require_setup_mode(db)
    return await disconnect_cloud(db)


# ---- cloud login (Phase 1) ---------------------------------------------------


def _safe_next_path(value: str | None) -> str | None:
    """Only same-origin absolute paths may be used as a post-login target."""
    if not value or not value.startswith("/") or value.startswith("//"):
        return None
    return value


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _browser_origin(request: Request) -> str | None:
    """The origin the user's browser is actually on. In development the UI
    (e.g. Vite on :8616) often proxies to the backend (:8989), and the link's
    registered local_origin is the proxied one — remember where the user
    started so the login callback can send them back there."""
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if origin.startswith("http://") or origin.startswith("https://"):
        return origin
    return _request_origin(request)


def _allowed_return_origin(origin: str | None, link: CloudBackendLink) -> str | None:
    """An origin the callback may bounce back to: the link's own origin, or a
    loopback host (development). Anything else could turn the callback into an
    open redirect for whoever started the flow."""
    if not origin:
        return None
    from urllib.parse import urlparse

    parsed = urlparse(origin)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    normalized = origin.rstrip("/")
    if parsed.hostname in LOOPBACK_HOSTS:
        return normalized
    if link.local_origin and normalized == link.local_origin.rstrip("/"):
        return normalized
    return None


def _login_redirect(reason: str) -> RedirectResponse:
    return RedirectResponse(f"/login?cloudError={reason}", status_code=HTTPStatus.SEE_OTHER)


async def _handoff_authorization_url(
    link: CloudBackendLink,
    redis: Redis,
    *,
    mode: str,
    next_path: str | None,
    user_id: int | None,
    intent: str,
    return_origin: str | None = None,
) -> str:
    """Start a login handoff with the provider and remember our state token."""
    access_token = cloud.decrypt_cloud_secret(link.access_token)
    if not access_token or not link.local_origin:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="The cloud link is incomplete; reconnect first")

    state = secrets.token_urlsafe(32)
    payload = {
        "redirect_uri": f"{link.local_origin.rstrip('/')}/api/cloud/login/callback",
        "state": state,
        "intent": intent,
    }
    try:
        status_code, response = await cloud.frameos_login_start(link.provider_url, access_token, payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc
    if status_code != 200 or not response.get("authorization_url"):
        detail = response.get("error") or f"unexpected status {status_code}"
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud rejected the login request: {detail}"
        )

    await redis.set(
        f"{CLOUD_LOGIN_STATE_PREFIX}{state}",
        json.dumps(
            {
                "mode": mode,
                "next": next_path,
                "user_id": user_id,
                "return_origin": _allowed_return_origin(return_origin, link),
            }
        ),
        ex=CLOUD_LOGIN_STATE_TTL_SECONDS,
    )
    return str(response["authorization_url"])


@api_open.get("/cloud/login/options", response_model=CloudLoginOptionsResponse)
async def cloud_login_options(db: Session = Depends(get_db)):
    """What the login and setup screens may offer. Intentionally unauthenticated
    and minimal: it reveals only that cloud login is possible, not who owns it."""
    link = _connected_link(db)
    # FRAMEOS_CLOUD_URL=disabled hides the cloud feature entirely.
    enabled = cloud.default_cloud_provider_url() is not None
    available = enabled and _link_has_scope(link, "auth:login")
    return {
        "available": available,
        "provider_url": link.provider_url if link else None,
        "local_login_enabled": link.local_fallback_enabled if link else True,
        "setup_mode": db.query(User).first() is None,
    }


@api_open.post("/cloud/login/start", response_model=CloudLoginStartResponse)
async def cloud_login_start(
    request: Request,
    data: CloudLoginStartRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    link = _connected_link(db)
    if link is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")
    if not _link_has_scope(link, "auth:login"):
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail="The cloud link is missing the auth:login permission; reconnect with it enabled",
        )
    setup_mode = db.query(User).first() is None
    authorization_url = await _handoff_authorization_url(
        link,
        redis,
        mode="login",
        next_path=_safe_next_path(data.next),
        user_id=None,
        intent="signup" if setup_mode else "login",
        return_origin=_browser_origin(request),
    )
    return {"authorization_url": authorization_url}


@api_user.post("/cloud/identity/link", response_model=CloudLoginStartResponse)
async def cloud_identity_link_start(
    request: Request,
    data: CloudLoginStartRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    current_user: User | None = Depends(get_current_user),
):
    """Explicitly link the logged-in local user to their cloud account. Runs the
    same browser handoff as login; the callback stores the identity mapping
    instead of creating a session."""
    if current_user is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Log in first")
    link = _connected_link(db)
    if link is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")
    if not _link_has_scope(link, "auth:login"):
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail="The cloud link is missing the auth:login permission; reconnect with it enabled",
        )
    authorization_url = await _handoff_authorization_url(
        link,
        redis,
        mode="link",
        next_path=_safe_next_path(data.next),
        user_id=current_user.id,
        intent="login",
        return_origin=_browser_origin(request),
    )
    return {"authorization_url": authorization_url}


def _upsert_cloud_identity(
    db: Session, user: User, link: CloudBackendLink, issuer: str, claims: dict
) -> CloudIdentity:
    subject = str(claims.get("provider_subject") or claims.get("sub") or "")
    identity = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.provider_issuer == issuer, CloudIdentity.provider_subject == subject)
        .first()
    )
    if identity is None:
        identity = CloudIdentity(provider_issuer=issuer, provider_subject=subject, user_id=user.id)
        db.add(identity)
    identity.user_id = user.id
    identity.provider_url = link.provider_url
    identity.cloud_account_id = claims.get("account_id")
    identity.email = claims.get("email")
    identity.email_verified = bool(claims.get("email_verified"))
    identity.name = claims.get("name")
    identity.updated_at = _now()
    return identity


@api_open.get("/cloud/login/callback")
async def cloud_login_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """The browser lands here after approving (or failing) a cloud login."""
    if not state:
        return _login_redirect("invalid_state")
    state_raw = await redis.get(f"{CLOUD_LOGIN_STATE_PREFIX}{state}")
    if state_raw:
        await redis.delete(f"{CLOUD_LOGIN_STATE_PREFIX}{state}")
    try:
        state_data = json.loads(state_raw) if state_raw else None
    except (TypeError, ValueError):
        state_data = None
    if not isinstance(state_data, dict):
        return _login_redirect("invalid_state")

    mode = state_data.get("mode") or "login"
    next_path = _safe_next_path(state_data.get("next"))

    link = _connected_link(db)
    # In development the UI origin (e.g. Vite on :8616) differs from the
    # link's registered origin that this callback runs on; send the browser
    # back to where it started. Only origins vetted at start time are stored.
    return_origin = _allowed_return_origin(state_data.get("return_origin"), link) if link else None

    def _target(path: str) -> str:
        if return_origin and return_origin != _request_origin(request):
            return f"{return_origin}{path}"
        return path

    def _fail(reason: str) -> RedirectResponse:
        return RedirectResponse(_target(f"/login?cloudError={reason}"), status_code=HTTPStatus.SEE_OTHER)

    if error:
        return _fail(error)

    access_token = cloud.decrypt_cloud_secret(link.access_token) if link else None
    if link is None or not access_token or not code:
        return _fail("not_connected")

    try:
        status_code, response = await cloud.frameos_login_token(link.provider_url, access_token, code)
    except Exception:  # noqa: BLE001
        return _fail("network_error")
    claims = response.get("claims")
    issuer = response.get("provider_issuer")
    if status_code != 200 or not isinstance(claims, dict) or not issuer:
        return _fail("exchange_failed")
    subject = str(claims.get("provider_subject") or claims.get("sub") or "")
    if not subject:
        return _fail("exchange_failed")

    if mode == "link":
        user = db.get(User, state_data.get("user_id"))
        if user is None:
            return _fail("invalid_state")
        existing = (
            db.query(CloudIdentity)
            .filter(CloudIdentity.provider_issuer == issuer, CloudIdentity.provider_subject == subject)
            .first()
        )
        if existing is not None and existing.user_id != user.id:
            return RedirectResponse(
                _target(f"{next_path or '/settings'}?cloudError=identity_in_use"),
                status_code=HTTPStatus.SEE_OTHER,
            )
        _upsert_cloud_identity(db, user, link, issuer, claims)
        db.commit()
        return RedirectResponse(_target(next_path or "/settings"), status_code=HTTPStatus.SEE_OTHER)

    # mode == "login"
    identity = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.provider_issuer == issuer, CloudIdentity.provider_subject == subject)
        .first()
    )
    if identity is None and claims.get("account_id"):
        # The same cloud account may sign in through different methods
        # (password vs. Google), each with its own issuer/subject. The
        # account id is the stable key, so fall back to it.
        identity = (
            db.query(CloudIdentity)
            .filter(
                CloudIdentity.cloud_account_id == str(claims["account_id"]),
                CloudIdentity.provider_url == link.provider_url,
            )
            .order_by(CloudIdentity.id.desc())
            .first()
        )
    if identity is not None:
        user = identity.user
    elif db.query(User).first() is None:
        # First-run setup: the cloud principal who approved this install's link
        # becomes the first local user. There is no password; they log in
        # through the cloud (and can add a local password later if needed).
        email = claims.get("email") or f"cloud-{claims.get('account_id') or subject}@frameos.local"
        user = User(email=email)
        db.add(user)
        db.flush()
        identity = _upsert_cloud_identity(db, user, link, issuer, claims)
    else:
        # A matching email is not proof of ownership: an existing local user
        # must log in and explicitly link their cloud account first.
        return _fail("not_linked")

    identity.last_login_at = _now()
    db.commit()

    from app.tenancy import ensure_default_project_for_user

    ensure_default_project_for_user(db, user)

    expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session_value, max_age = create_session_cookie_value(email=user.email, expires_delta=expires)
    redirect = RedirectResponse(_target(next_path or "/"), status_code=HTTPStatus.SEE_OTHER)
    redirect.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )
    return redirect


@api_user.post("/cloud/identity/unlink", response_model=CloudStatusResponse)
async def cloud_identity_unlink(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    if current_user is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Log in first")
    link = current_cloud_backend_link(db)
    if link is not None and link.status == "connected" and not link.local_fallback_enabled:
        raise HTTPException(
            status_code=HTTPStatus.CONFLICT,
            detail="Local password login is disabled; re-enable it before unlinking your cloud account",
        )
    db.query(CloudIdentity).filter(CloudIdentity.user_id == current_user.id).delete()
    db.commit()
    return _status_payload(db, link, current_user)


@api_user.post("/cloud/local-fallback", response_model=CloudStatusResponse)
async def set_local_fallback(
    data: CloudLocalFallbackRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    """Enable or disable local password login. Disabling requires a verified,
    working cloud login for the link's owner, so nobody locks themselves out."""
    link = current_cloud_backend_link(db)
    if link is None:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")

    if data.enabled:
        link.local_fallback_enabled = True
        link.updated_at = _now()
        db.commit()
        return _status_payload(db, link, current_user)

    if current_user is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Log in first")
    if link.status != "connected" or not _link_has_scope(link, "auth:login"):
        raise HTTPException(
            status_code=HTTPStatus.CONFLICT,
            detail="Connect to FrameOS Cloud with the auth:login permission first",
        )
    identity = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.user_id == current_user.id)
        .order_by(CloudIdentity.id.desc())
        .first()
    )
    if identity is None or not identity.cloud_account_id or identity.cloud_account_id != link.cloud_account_id:
        raise HTTPException(
            status_code=HTTPStatus.CONFLICT,
            detail="Link your account to the cloud account that owns this install first",
        )

    # Verify the link actually works right now — a dead link plus disabled
    # passwords would lock the install.
    access_token = cloud.decrypt_cloud_secret(link.access_token)
    try:
        status_code, _ = await cloud.backend_grants(link.provider_url, access_token or "")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not verify the cloud link: {exc}"
        ) from exc
    if status_code != 200:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail="The cloud link did not verify; local login stays enabled",
        )

    link.local_fallback_enabled = False
    link.updated_at = _now()
    db.commit()
    return _status_payload(db, link, current_user)


# ---- enabled features (in-place scope changes) --------------------------------

BASE_LINK_SCOPES = ("backend:link", "backend:read")


@api_user.post("/cloud/features", response_model=CloudStatusResponse)
async def set_cloud_features(
    data: CloudFeaturesRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    """Change which features this link may use, without disconnecting.
    Removals apply immediately; additions need the owner's approval on the
    provider (the status payload gains an "upgrade" block to poll)."""
    link = _connected_link(db)
    access_token = cloud.decrypt_cloud_secret(link.access_token) if link else None
    if link is None or not access_token:
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="This install is not linked to FrameOS Cloud")
    if link.device_code:
        raise HTTPException(
            status_code=HTTPStatus.CONFLICT,
            detail="A feature change is already waiting for approval; approve or cancel it first",
        )

    features = [s for s in data.scopes if s in KNOWN_SCOPES and s not in BASE_LINK_SCOPES]
    scopes = list(BASE_LINK_SCOPES) + features

    try:
        status_code, response = await cloud.backend_set_scopes(link.provider_url, access_token, scopes)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY, detail=f"Could not reach {link.provider_url}: {exc}"
        ) from exc

    if status_code == 200 and response.get("status") == "updated":
        if response.get("scope"):
            link.scope = response["scope"]
        link.poll_error = None
        link.updated_at = _now()
        db.commit()
        await _nudge_cloud_sync()
        return _status_payload(db, link, current_user)

    if status_code == 200 and response.get("status") == "approval_required" and response.get("device_code"):
        link.device_code = response["device_code"]
        link.user_code = response.get("user_code")
        link.verification_uri = response.get("verification_uri")
        link.verification_uri_complete = response.get("verification_uri_complete")
        link.interval_seconds = int(response.get("interval") or 5)
        expires_in = response.get("expires_in")
        link.expires_at = _now() + datetime.timedelta(seconds=int(expires_in)) if expires_in else None
        link.poll_error = None
        link.updated_at = _now()
        db.commit()
        return _status_payload(db, link, current_user)

    detail = response.get("error") or f"unexpected status {status_code}"
    raise HTTPException(
        status_code=HTTPStatus.BAD_GATEWAY, detail=f"FrameOS Cloud rejected the feature change: {detail}"
    )


@api_user.post("/cloud/features/cancel", response_model=CloudStatusResponse)
async def cancel_cloud_features(
    db: Session = Depends(get_db), current_user: User | None = Depends(get_current_user)
):
    """Forget a pending feature-change approval (it expires provider-side)."""
    link = current_cloud_backend_link(db)
    if _upgrade_pending(link):
        _clear_upgrade(link)
        db.commit()
    return _status_payload(db, link, current_user)
