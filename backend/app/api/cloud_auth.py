from __future__ import annotations

import datetime
import hashlib
import secrets
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from jose import JWTError
from sqlalchemy.orm import Session
from werkzeug.security import generate_password_hash

from app import config as app_config
from app.api.auth import ACCESS_TOKEN_EXPIRE_MINUTES, _should_use_secure_cookie, get_current_user
from app.database import get_db
from app.models.cloud_auth import (
    CloudBackendLink,
    CloudIdentity,
    CloudMembership,
    current_cloud_backend_link,
    local_fallback_enabled,
)
from app.models.frame import Frame
from app.models.organization import OrganizationMember
from app.models.user import User
from app.schemas.cloud_auth import (
    CloudAuthPublicStatus,
    CloudAuthStatusResponse,
    CloudBackendLinkPollResponse,
    CloudBackendLinkStartRequest,
    CloudBackendLinkStartResponse,
    CloudLinkSyncResponse,
    CloudLocalFallbackUpdateRequest,
    CloudTokenRotateResponse,
)
from app.tenancy import current_project_context
from app.utils.cloud_auth import (
    CLOUD_OIDC_COOKIE_MAX_AGE_SECONDS,
    CLOUD_OIDC_COOKIE_NAME,
    build_authorization_url,
    create_cloud_oidc_cookie_value,
    create_pkce_pair,
    decode_cloud_oidc_cookie_value,
    decrypt_cloud_secret,
    discover_oidc_provider,
    encrypt_cloud_secret,
    exchange_authorization_code,
    provider_json_request,
    random_urlsafe_token,
    verify_oidc_id_token,
)
from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value
from app.utils.versions import current_frameos_version

from . import api_open, api_project


OWNER_ADMIN_ROLES = {"owner", "admin"}
ROLE_PRIORITY = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


def _provider_enabled() -> bool:
    return not app_config.config.FRAMEOS_AUTH_PROVIDER_DISABLED and bool(app_config.config.FRAMEOS_AUTH_PROVIDER_URL)


def _provider_url() -> str:
    if not _provider_enabled() or not app_config.config.FRAMEOS_AUTH_PROVIDER_URL:
        raise HTTPException(status_code=404, detail="FrameOS Cloud Auth is disabled")
    return app_config.config.FRAMEOS_AUTH_PROVIDER_URL


def _request_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}".rstrip("/")


def _safe_origin(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return parsed._replace(path="", params="", query="", fragment="").geturl().rstrip("/")


def _cloud_auth_callback_url(request: Request, callback_origin: str | None = None) -> str:
    origin = _safe_origin(callback_origin) or _request_origin(request)
    return f"{origin}{request.app.url_path_for('cloud_auth_callback')}"


def _safe_redirect_path(value: str | None) -> str:
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


def _set_cloud_oidc_cookie(request: Request, response: RedirectResponse, payload: dict[str, Any]) -> None:
    response.set_cookie(
        key=CLOUD_OIDC_COOKIE_NAME,
        value=create_cloud_oidc_cookie_value(
            {
                **payload,
                "issued_at": int(datetime.datetime.utcnow().timestamp()),
            }
        ),
        max_age=CLOUD_OIDC_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )


def _session_redirect(request: Request, user: User, redirect_to: str | None) -> RedirectResponse:
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session_value, max_age = create_session_cookie_value(email=user.email, expires_delta=access_token_expires)
    redirect = RedirectResponse(url=_safe_redirect_path(redirect_to), status_code=302)
    redirect.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )
    redirect.delete_cookie(key=CLOUD_OIDC_COOKIE_NAME)
    return redirect


def _http_client(request: Request):
    return getattr(request.app.state, "http_client", None)


def _link_response(link: CloudBackendLink | None) -> dict | None:
    return link.to_public_dict() if link else None


def _current_user_cloud_identities(user: User | None) -> list[dict[str, Any]]:
    if user is None:
        return []
    return [
        {
            "provider_url": identity.provider_url,
            "provider_issuer": identity.provider_issuer,
            "provider_subject": identity.provider_subject,
            "cloud_account_id": identity.cloud_account_id,
            "email": identity.email,
            "email_verified": identity.email_verified,
            "name": identity.name,
            "last_login_at": identity.last_login_at.isoformat() if identity.last_login_at else None,
        }
        for identity in user.cloud_identities
    ]


def _status_payload(db: Session, user: User | None = None) -> dict:
    enabled = _provider_enabled()
    link = current_cloud_backend_link(db)
    link_payload = _link_response(link)
    memberships = [membership.to_dict() for membership in link.memberships] if link else []
    return {
        "provider_enabled": enabled,
        "provider_url": app_config.config.FRAMEOS_AUTH_PROVIDER_URL if enabled else None,
        "status": link.status if enabled and link else "disconnected" if enabled else "provider_disabled",
        "local_fallback_enabled": local_fallback_enabled(db),
        "link": link_payload,
        "memberships": memberships,
        "current_user_cloud_identities": _current_user_cloud_identities(user),
    }


def _cloud_account_id_from_claims(claims: dict[str, Any]) -> str | None:
    for key in ("frameos_account_id", "account_id", "https://frameos.net/account_id"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _claim_string(claims: dict[str, Any], key: str) -> str | None:
    value = claims.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _generated_cloud_email(issuer: str, subject: str) -> str:
    digest = hashlib.sha256(f"{issuer}:{subject}".encode()).hexdigest()[:24]
    return f"cloud-{digest}@frameos.cloud.local"


def _email_available_for_cloud_user(db: Session, email: str | None) -> str | None:
    if not email:
        return None
    if email.count("@") != 1:
        return None
    if db.query(User).filter(User.email == email).first() is not None:
        return None
    return email


def _membership_matches_identity(membership: CloudMembership, identity: CloudIdentity) -> bool:
    return bool(identity.cloud_account_id and membership.cloud_account_id == identity.cloud_account_id)


def _preferred_cloud_role(current: str | None, candidate: str) -> str:
    if current is None:
        return candidate
    if ROLE_PRIORITY.get(candidate.lower(), 0) > ROLE_PRIORITY.get(current.lower(), 0):
        return candidate
    return current


def _ensure_user_cloud_memberships(db: Session, identity: CloudIdentity) -> None:
    if not identity.cloud_account_id or not identity.user_id:
        return

    memberships = db.query(CloudMembership).filter(CloudMembership.cloud_account_id == identity.cloud_account_id).all()
    roles_by_organization_id: dict[int, str] = {}
    for membership in memberships:
        if not membership.local_organization_id:
            continue
        organization_id = int(membership.local_organization_id)
        roles_by_organization_id[organization_id] = _preferred_cloud_role(
            roles_by_organization_id.get(organization_id),
            membership.role,
        )

    if not roles_by_organization_id:
        return

    organization_ids = list(roles_by_organization_id)
    existing_members = {
        int(member.organization_id): member
        for member in db.query(OrganizationMember)
        .filter(
            OrganizationMember.organization_id.in_(organization_ids),
            OrganizationMember.user_id == identity.user_id,
        )
        .all()
    }
    pending_members = {
        int(member.organization_id): member
        for member in db.new
        if isinstance(member, OrganizationMember)
        and member.user_id == identity.user_id
        and member.organization_id in roles_by_organization_id
    }
    for organization_id, role in roles_by_organization_id.items():
        existing = existing_members.get(organization_id) or pending_members.get(organization_id)
        if existing:
            existing.role = role
            continue
        db.add(
            OrganizationMember(
                organization_id=organization_id,
                user_id=identity.user_id,
                role=role,
            )
        )


def _connected_link_requires_grant(db: Session) -> CloudBackendLink | None:
    link = current_cloud_backend_link(db)
    if link and link.status == "connected" and link.local_organization_id:
        return link
    return None


def _user_has_link_grant(db: Session, user: User, link: CloudBackendLink) -> bool:
    return (
        db.query(OrganizationMember)
        .filter(
            OrganizationMember.organization_id == link.local_organization_id,
            OrganizationMember.user_id == user.id,
        )
        .first()
        is not None
    )


def _get_or_create_cloud_user(
    db: Session,
    *,
    provider_url: str,
    issuer: str,
    claims: dict[str, Any],
) -> User:
    subject = str(claims["sub"])
    now = datetime.datetime.utcnow()
    identity = (
        db.query(CloudIdentity)
        .filter(CloudIdentity.provider_issuer == issuer, CloudIdentity.provider_subject == subject)
        .first()
    )
    email = _claim_string(claims, "email")
    email_verified = bool(claims.get("email_verified"))
    name = _claim_string(claims, "name")
    cloud_account_id = _cloud_account_id_from_claims(claims)

    if identity:
        identity.provider_url = provider_url
        identity.email = email
        identity.email_verified = email_verified
        identity.name = name
        identity.cloud_account_id = cloud_account_id
        identity.last_login_at = now
        identity.updated_at = now
        _ensure_user_cloud_memberships(db, identity)
        db.commit()
        return identity.user

    local_email = _email_available_for_cloud_user(db, email if email_verified else None)
    user = User(email=local_email or _generated_cloud_email(issuer, subject))
    user.password = generate_password_hash(secrets.token_urlsafe(32))
    db.add(user)
    db.flush()

    identity = CloudIdentity(
        user_id=user.id,
        provider_url=provider_url,
        provider_issuer=issuer,
        provider_subject=subject,
        cloud_account_id=cloud_account_id,
        email=email,
        email_verified=email_verified,
        name=name,
        last_login_at=now,
        updated_at=now,
    )
    db.add(identity)
    _ensure_user_cloud_memberships(db, identity)

    if _connected_link_requires_grant(db) is None:
        from app.tenancy import ensure_default_project_for_user

        ensure_default_project_for_user(db, user)
    db.commit()
    db.refresh(user)
    return user


async def _sync_inventory(db: Session, link: CloudBackendLink, request: Request) -> bool:
    access_token = decrypt_cloud_secret(link.access_token)
    if not access_token:
        return False

    frames = []
    if link.local_project_id:
        for frame in db.query(Frame).filter(Frame.project_id == link.local_project_id).all():
            frames.append(
                {
                    "frame_id": str(frame.id),
                    "display_name": frame.name or f"Frame {frame.id}",
                    "connection_status": frame.status or "unknown",
                    "device_metadata": {"device": frame.device or "web_only"},
                }
            )

    status_code, payload = await provider_json_request(
        "POST",
        link.provider_url,
        "/api/backends/inventory",
        access_token=access_token,
        http_client=_http_client(request),
        json_body={
            "reported_frameos_version": current_frameos_version(),
            "capabilities": {"projects": True, "frames": True, "localFallback": link.local_fallback_enabled},
            "health": {"status": "ok"},
            "frames": frames,
        },
    )
    if status_code == 401 and payload.get("error") == "invalid_link_token":
        link.status = "revoked"
        link.revoked_at = datetime.datetime.utcnow()
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return False
    if status_code < 200 or status_code >= 300:
        return False
    link.last_inventory_sync_at = datetime.datetime.utcnow()
    link.updated_at = link.last_inventory_sync_at
    db.commit()
    return True


def _parse_provider_datetime(value: Any) -> datetime.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _replace_cloud_memberships(db: Session, link: CloudBackendLink, grants: list[dict[str, Any]]) -> None:
    db.query(CloudMembership).filter(CloudMembership.backend_link_id == link.id).delete()
    for grant in grants:
        account_id = grant.get("account_id")
        organization_id = grant.get("organization_id")
        role = grant.get("role")
        if not isinstance(account_id, str) or not isinstance(organization_id, str) or not isinstance(role, str):
            continue
        cloud_project_id = grant.get("project_id") if isinstance(grant.get("project_id"), str) else None
        if link.cloud_project_id and cloud_project_id and cloud_project_id != link.cloud_project_id:
            continue
        db.add(
            CloudMembership(
                backend_link_id=link.id,
                cloud_account_id=account_id,
                cloud_organization_id=organization_id,
                cloud_project_id=cloud_project_id,
                role=role,
                local_organization_id=link.local_organization_id,
                local_project_id=link.local_project_id,
                updated_at=_parse_provider_datetime(grant.get("updated_at")),
            )
        )

    db.flush()
    for identity in db.query(CloudIdentity).all():
        _ensure_user_cloud_memberships(db, identity)


async def _sync_grants(db: Session, link: CloudBackendLink, request: Request) -> bool:
    access_token = decrypt_cloud_secret(link.access_token)
    if not access_token:
        return False

    status_code, payload = await provider_json_request(
        "GET",
        link.provider_url,
        "/api/backends/grants",
        access_token=access_token,
        http_client=_http_client(request),
    )
    if status_code == 401 and payload.get("error") == "invalid_link_token":
        link.status = "revoked"
        link.revoked_at = datetime.datetime.utcnow()
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return False
    if status_code < 200 or status_code >= 300:
        return False

    memberships = payload.get("memberships")
    _replace_cloud_memberships(db, link, memberships if isinstance(memberships, list) else [])
    link.last_grant_sync_at = datetime.datetime.utcnow()
    link.updated_at = link.last_grant_sync_at
    db.commit()
    return True


async def _sync_link(db: Session, link: CloudBackendLink, request: Request) -> tuple[bool, bool]:
    inventory_synced = await _sync_inventory(db, link, request)
    grants_synced = await _sync_grants(db, link, request)
    return inventory_synced, grants_synced


def _current_user_can_disable_fallback(db: Session, current_user: User) -> bool:
    link = current_cloud_backend_link(db)
    if not link or link.status != "connected":
        return False
    for identity in current_user.cloud_identities:
        for membership in link.memberships:
            if _membership_matches_identity(membership, identity) and membership.role.lower() in OWNER_ADMIN_ROLES:
                return True
    return False


async def _start_brokered_cloud_login(
    *,
    request: Request,
    db: Session,
    provider_url: str,
    intent: str,
    redirect_to: str | None,
    callback_origin: str | None = None,
) -> RedirectResponse | None:
    link = current_cloud_backend_link(db)
    if not link or link.status != "connected":
        return None
    access_token = decrypt_cloud_secret(link.access_token)
    if not access_token:
        return None

    state = random_urlsafe_token()
    redirect_uri = _cloud_auth_callback_url(request, callback_origin)
    try:
        status_code, payload = await provider_json_request(
            "POST",
            provider_url,
            "/api/frameos/login/start",
            access_token=access_token,
            http_client=_http_client(request),
            json_body={
                "redirect_uri": redirect_uri,
                "state": state,
                "intent": "signup" if intent == "signup" else "login",
                "redirect_to": _safe_redirect_path(redirect_to),
            },
        )
    except Exception:
        return None
    if status_code < 200 or status_code >= 300:
        return None
    authorization_url = payload.get("authorization_url")
    if not isinstance(authorization_url, str) or not authorization_url:
        return None

    response = RedirectResponse(url=authorization_url, status_code=302)
    _set_cloud_oidc_cookie(
        request,
        response,
        {
            "flow": "broker",
            "state": state,
            "provider_url": provider_url,
            "redirect_to": _safe_redirect_path(redirect_to),
        },
    )
    return response


async def _exchange_brokered_cloud_login(
    *,
    request: Request,
    db: Session,
    provider_url: str,
    code: str,
) -> tuple[str, dict[str, Any]]:
    link = current_cloud_backend_link(db)
    if not link or link.status != "connected":
        raise HTTPException(status_code=400, detail="Cloud backend is not connected")
    access_token = decrypt_cloud_secret(link.access_token)
    if not access_token:
        raise HTTPException(status_code=400, detail="Cloud backend token is missing")

    status_code, payload = await provider_json_request(
        "POST",
        provider_url,
        "/api/frameos/login/token",
        access_token=access_token,
        http_client=_http_client(request),
        json_body={"code": code},
    )
    if status_code < 200 or status_code >= 300:
        raise HTTPException(status_code=502, detail=payload.get("error") or "Cloud login exchange failed")

    claims_payload = payload.get("claims") if isinstance(payload.get("claims"), dict) else payload
    subject = claims_payload.get("sub") or claims_payload.get("provider_subject")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(status_code=502, detail="Cloud login exchange returned no subject")

    claims = {
        "sub": subject,
        "email": claims_payload.get("email"),
        "email_verified": bool(claims_payload.get("email_verified")),
        "name": claims_payload.get("name"),
        "account_id": claims_payload.get("account_id") or claims_payload.get("cloud_account_id"),
    }
    issuer = payload.get("provider_issuer") or claims_payload.get("provider_issuer") or provider_url
    return str(issuer), claims


async def _finish_cloud_login(
    *,
    request: Request,
    db: Session,
    provider_url: str,
    issuer: str,
    claims: dict[str, Any],
    redirect_to: str | None,
) -> RedirectResponse:
    user = _get_or_create_cloud_user(db, provider_url=provider_url, issuer=issuer, claims=claims)
    required_link = _connected_link_requires_grant(db)
    if required_link is not None and not _user_has_link_grant(db, user, required_link):
        return RedirectResponse(url="/login?error=cloud_grant_required", status_code=302)
    return _session_redirect(request, user, redirect_to)


@api_open.get("/cloud-auth/status", response_model=CloudAuthPublicStatus)
async def get_public_cloud_auth_status(db: Session = Depends(get_db)):
    payload = _status_payload(db)
    return {
        "provider_enabled": payload["provider_enabled"],
        "provider_url": payload["provider_url"],
        "status": payload["status"],
        "local_fallback_enabled": payload["local_fallback_enabled"],
    }


@api_project.get("/cloud-auth/status", response_model=CloudAuthStatusResponse)
async def get_project_cloud_auth_status(
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _status_payload(db, current_user)


@api_open.get("/cloud-auth/login")
async def start_cloud_login(
    request: Request,
    intent: str = Query("login"),
    redirect_to: str | None = Query(None),
    callback_origin: str | None = Query(None),
    db: Session = Depends(get_db),
):
    provider_url = _provider_url()
    brokered = await _start_brokered_cloud_login(
        request=request,
        db=db,
        provider_url=provider_url,
        intent=intent,
        redirect_to=redirect_to,
        callback_origin=callback_origin,
    )
    if brokered:
        return brokered

    try:
        discovery = await discover_oidc_provider(provider_url, _http_client(request))
    except Exception:
        return RedirectResponse(url=f"/login?error=provider_unavailable", status_code=302)

    state = random_urlsafe_token()
    nonce = random_urlsafe_token()
    verifier, challenge = create_pkce_pair()
    redirect_uri = _cloud_auth_callback_url(request, callback_origin)
    authorization_url = build_authorization_url(
        discovery,
        client_id=app_config.config.FRAMEOS_AUTH_CLIENT_ID,
        code_challenge=challenge,
        nonce=nonce,
        redirect_uri=redirect_uri,
        state=state,
        intent="signup" if intent == "signup" else "login",
    )

    response = RedirectResponse(url=authorization_url, status_code=302)
    _set_cloud_oidc_cookie(
        request,
        response,
        {
            "flow": "oidc",
            "state": state,
            "nonce": nonce,
            "verifier": verifier,
            "provider_url": provider_url,
            "redirect_to": _safe_redirect_path(redirect_to),
        },
    )
    return response


@api_open.get("/cloud-auth/callback", name="cloud_auth_callback")
async def cloud_auth_callback(
    request: Request,
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    db: Session = Depends(get_db),
):
    if error:
        return RedirectResponse(url=f"/login?error={error}", status_code=302)

    cookie_payload = decode_cloud_oidc_cookie_value(request.cookies.get(CLOUD_OIDC_COOKIE_NAME))
    if not code or not state or not cookie_payload or cookie_payload.get("state") != state:
        return RedirectResponse(url="/login?error=invalid_state", status_code=302)
    issued_at = cookie_payload.get("issued_at")
    if not isinstance(issued_at, int) or int(datetime.datetime.utcnow().timestamp()) - issued_at > CLOUD_OIDC_COOKIE_MAX_AGE_SECONDS:
        return RedirectResponse(url="/login?error=invalid_state", status_code=302)

    provider_url = str(cookie_payload.get("provider_url") or _provider_url())
    redirect_uri = _cloud_auth_callback_url(request)
    if cookie_payload.get("flow") == "broker":
        try:
            issuer, claims = await _exchange_brokered_cloud_login(
                request=request,
                db=db,
                provider_url=provider_url,
                code=code,
            )
        except Exception:
            return RedirectResponse(url="/login?error=provider_unavailable", status_code=302)
        return await _finish_cloud_login(
            request=request,
            db=db,
            provider_url=provider_url,
            issuer=issuer,
            claims=claims,
            redirect_to=str(cookie_payload.get("redirect_to") or "/"),
        )

    try:
        discovery = await discover_oidc_provider(provider_url, _http_client(request))
        token_set = await exchange_authorization_code(
            discovery,
            client_id=app_config.config.FRAMEOS_AUTH_CLIENT_ID,
            client_secret=app_config.config.FRAMEOS_AUTH_CLIENT_SECRET or None,
            code=code,
            code_verifier=str(cookie_payload["verifier"]),
            redirect_uri=redirect_uri,
            http_client=_http_client(request),
        )
        claims = await verify_oidc_id_token(
            str(token_set["id_token"]),
            audience=app_config.config.FRAMEOS_AUTH_CLIENT_ID,
            discovery=discovery,
            nonce=str(cookie_payload["nonce"]),
            http_client=_http_client(request),
        )
    except (JWTError, Exception):
        return RedirectResponse(url="/login?error=provider_unavailable", status_code=302)

    return await _finish_cloud_login(
        request=request,
        db=db,
        provider_url=provider_url,
        issuer=discovery.issuer,
        claims=claims,
        redirect_to=str(cookie_payload.get("redirect_to") or "/"),
    )


@api_project.post("/cloud-auth/backend-link/start", response_model=CloudBackendLinkStartResponse)
async def start_backend_link(
    request: Request,
    data: CloudBackendLinkStartRequest | None = None,
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    provider_url = _provider_url()
    project_context = current_project_context()
    local_origin = data.local_origin if data and data.local_origin else _request_origin(request)
    display_name = (
        data.public_display_name
        if data and data.public_display_name
        else f"FrameOS backend at {request.headers.get('host') or request.url.netloc}"
    )
    try:
        status_code, payload = await provider_json_request(
            "POST",
            provider_url,
            "/api/device/start",
            http_client=_http_client(request),
            json_body={
                "client_type": "backend",
                "public_display_name": display_name,
                "local_origin": local_origin,
                "reported_frameos_version": current_frameos_version(),
                "capabilities": {"projects": True, "frames": True, "localFallback": True},
                "scopes": ["backend:link", "backend:read", "project:read"],
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cloud auth provider unavailable: {exc}") from exc
    if status_code < 200 or status_code >= 300:
        raise HTTPException(status_code=502, detail=payload.get("error") or "Cloud auth provider rejected link start")

    link = current_cloud_backend_link(db) or CloudBackendLink(provider_url=provider_url)
    link.provider_url = provider_url
    link.provider_issuer = None
    link.status = "connecting"
    link.public_display_name = display_name
    link.local_origin = local_origin
    link.device_code = encrypt_cloud_secret(str(payload["device_code"]))
    link.user_code = str(payload["user_code"])
    link.verification_uri = str(payload["verification_uri"])
    link.verification_uri_complete = str(payload["verification_uri_complete"])
    link.expires_at = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(payload.get("expires_in") or 600))
    link.interval_seconds = int(payload.get("interval") or 5)
    link.poll_error = None
    link.local_project_id = project_context.project_id
    link.local_organization_id = project_context.organization_id
    link.local_fallback_enabled = True if link.local_fallback_enabled is None else link.local_fallback_enabled
    link.updated_at = datetime.datetime.utcnow()
    db.add(link)
    db.query(CloudMembership).filter(CloudMembership.backend_link_id == link.id).delete()
    db.commit()
    db.refresh(link)
    return _status_payload(db, current_user)


@api_project.post("/cloud-auth/backend-link/poll", response_model=CloudBackendLinkPollResponse)
async def poll_backend_link(
    request: Request,
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    link = current_cloud_backend_link(db)
    if not link or link.status != "connecting":
        raise HTTPException(status_code=400, detail="No cloud backend link is currently connecting")
    if link.expires_at and link.expires_at < datetime.datetime.utcnow():
        link.status = "disconnected"
        link.poll_error = "expired_token"
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return _status_payload(db, current_user)
    device_code = decrypt_cloud_secret(link.device_code)
    if not device_code:
        raise HTTPException(status_code=400, detail="Cloud backend link device code is missing")

    status_code, payload = await provider_json_request(
        "POST",
        link.provider_url,
        "/api/device/poll",
        http_client=_http_client(request),
        json_body={"device_code": device_code},
    )
    error = payload.get("error")
    if error in {"authorization_pending", "slow_down"}:
        link.interval_seconds = int(payload.get("interval") or link.interval_seconds or 5)
        link.poll_error = str(error)
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return _status_payload(db, current_user)
    if error in {"access_denied", "expired_token", "invalid_device_code"}:
        link.status = "disconnected"
        link.poll_error = str(error)
        link.device_code = None
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return _status_payload(db, current_user)
    if status_code < 200 or status_code >= 300:
        link.poll_error = str(error or f"provider_status_{status_code}")
        link.updated_at = datetime.datetime.utcnow()
        db.commit()
        return _status_payload(db, current_user)

    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise HTTPException(status_code=502, detail="Cloud auth provider returned no access token")

    link.status = "connected"
    link.access_token = encrypt_cloud_secret(access_token)
    link.device_code = None
    link.poll_error = None
    link.token_reference = str(payload.get("token_reference") or "")
    link.linked_client_id = str(payload.get("linked_client_id") or "")
    link.cloud_organization_id = str(payload.get("organization_id") or "")
    link.cloud_project_id = str(payload.get("project_id") or "") or None
    link.scope = str(payload.get("scope") or "")
    link.revoked_at = None
    link.updated_at = datetime.datetime.utcnow()
    db.commit()
    await _sync_link(db, link, request)
    return _status_payload(db, current_user)


@api_project.post("/cloud-auth/backend-link/sync", response_model=CloudLinkSyncResponse)
async def sync_backend_link(
    request: Request,
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    link = current_cloud_backend_link(db)
    if not link or link.status not in {"connected", "revoked"}:
        raise HTTPException(status_code=400, detail="Cloud backend is not connected")
    inventory_synced, grants_synced = await _sync_link(db, link, request)
    return {
        **_status_payload(db, current_user),
        "inventory_synced": inventory_synced,
        "grants_synced": grants_synced,
        "errors": [] if inventory_synced and grants_synced else ["Cloud sync was incomplete"],
    }


@api_project.post("/cloud-auth/backend-link/rotate-token", response_model=CloudTokenRotateResponse)
async def rotate_backend_link_token(
    request: Request,
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    link = current_cloud_backend_link(db)
    if not link or link.status != "connected":
        raise HTTPException(status_code=400, detail="Cloud backend is not connected")
    access_token = decrypt_cloud_secret(link.access_token)
    if not access_token:
        raise HTTPException(status_code=400, detail="Cloud backend token is missing")
    status_code, payload = await provider_json_request(
        "POST",
        link.provider_url,
        "/api/backends/rotate-token",
        access_token=access_token,
        http_client=_http_client(request),
    )
    if status_code < 200 or status_code >= 300:
        raise HTTPException(status_code=502, detail=payload.get("error") or "Cloud token rotation failed")
    new_token = payload.get("access_token")
    if not isinstance(new_token, str) or not new_token:
        raise HTTPException(status_code=502, detail="Cloud token rotation returned no access token")
    link.access_token = encrypt_cloud_secret(new_token)
    link.token_reference = str(payload.get("token_reference") or link.token_reference or "")
    link.updated_at = datetime.datetime.utcnow()
    db.commit()
    return {**_status_payload(db, current_user), "rotated": True}


@api_project.delete("/cloud-auth/backend-link", response_model=CloudAuthStatusResponse)
async def disconnect_backend_link(
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    link = current_cloud_backend_link(db)
    if link:
        link.status = "disconnected"
        link.access_token = None
        link.device_code = None
        link.poll_error = None
        link.updated_at = datetime.datetime.utcnow()
        db.query(CloudMembership).filter(CloudMembership.backend_link_id == link.id).delete()
        db.commit()
    return _status_payload(db, current_user)


@api_project.post("/cloud-auth/local-fallback", response_model=CloudAuthStatusResponse)
async def set_local_fallback(
    data: CloudLocalFallbackUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    link = current_cloud_backend_link(db)
    if not link or link.status != "connected":
        raise HTTPException(status_code=400, detail="Connect FrameOS Cloud before changing local fallback.")
    if not data.enabled and not _current_user_can_disable_fallback(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Disabling local fallback requires a working cloud owner/admin session.",
        )
    link.local_fallback_enabled = data.enabled
    link.updated_at = datetime.datetime.utcnow()
    db.commit()
    return _status_payload(db, current_user)
