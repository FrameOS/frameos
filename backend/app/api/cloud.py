"""Linking this FrameOS installation to a FrameOS Cloud provider.

Phase 0 of CLOUD-TODO.md: establish and hold a scoped link token via the
OAuth 2.0 Device Authorization Grant. The protocol is documented in
docs/cloud-link.md; the provider URL is user-editable so any compatible
server works. All connections are outbound-only, initiated here.
"""
from __future__ import annotations

import datetime
from http import HTTPStatus

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cloud import CloudBackendLink, current_cloud_backend_link, link_is_expired
from app.schemas.cloud import CloudConnectRequest, CloudProviderUpdateRequest, CloudStatusResponse
from app.utils import cloud_link as cloud
from app.utils.versions import current_frameos_version

from . import api_user

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


def _status_payload(db: Session, link: CloudBackendLink | None) -> dict:
    default_url = cloud.default_cloud_provider_url()
    enabled = default_url is not None
    if link is not None and link_is_expired(link, _now()):
        _reset_link(link, poll_error="expired")
        db.commit()

    status = link.status if link else "disconnected"
    payload: dict = {
        "enabled": enabled,
        "provider_url": _effective_provider_url(link),
        "default_provider_url": default_url,
        "status": status,
        "can_edit_provider": status == "disconnected",
        "poll_error": link.poll_error if link else None,
        "connection": None,
        "link": None,
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
    return payload


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
    link.updated_at = _now()


@api_user.get("/cloud/status", response_model=CloudStatusResponse)
async def get_cloud_status(db: Session = Depends(get_db)):
    return _status_payload(db, current_cloud_backend_link(db))


@api_user.post("/cloud/provider", response_model=CloudStatusResponse)
async def set_cloud_provider(data: CloudProviderUpdateRequest, db: Session = Depends(get_db)):
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


@api_user.post("/cloud/connect", response_model=CloudStatusResponse)
async def connect_cloud(request: Request, data: CloudConnectRequest, db: Session = Depends(get_db)):
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


@api_user.post("/cloud/poll", response_model=CloudStatusResponse)
async def poll_cloud(db: Session = Depends(get_db)):
    link = current_cloud_backend_link(db)
    if link is None or link.status != "connecting" or not link.device_code:
        return _status_payload(db, link)

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
        return _status_payload(db, link)

    # denied / expired / anything else: back to square one with the reason kept
    _reset_link(link, poll_error=error or f"unexpected status {status_code}")
    db.commit()
    return _status_payload(db, link)


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
