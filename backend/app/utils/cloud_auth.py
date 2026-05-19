from __future__ import annotations

import secrets

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.cloud import CloudAuthSession, expires_in
from app.utils.cloud import build_cloud_auth_url, request_origin, return_to_origin, state_hash


def backend_display_name(request: Request) -> str:
    host = request.headers.get("host") or request.url.netloc or "FrameOS backend"
    return f"FrameOS backend ({host})"


def create_cloud_auth_session(
    *,
    db: Session,
    request: Request,
    purpose: str,
    user_id: int | None = None,
    backend_name: str | None = None,
    backend_url: str | None = None,
    return_to: str | None = None,
    pending_email: str | None = None,
    pending_password_hash: str | None = None,
) -> tuple[CloudAuthSession, str]:
    state = secrets.token_urlsafe(32)
    origin = request_origin(request)
    public_origin = return_to_origin(return_to) or origin
    redirect_uri = f"{public_origin}/api/cloud/callback"
    session = CloudAuthSession(
        state_hash=state_hash(state),
        purpose=purpose,
        user_id=user_id,
        backend_name=backend_name or backend_display_name(request),
        backend_url=backend_url or public_origin,
        redirect_uri=redirect_uri,
        return_to=return_to,
        pending_email=pending_email,
        pending_password_hash=pending_password_hash,
        expires_at=expires_in(10),
    )
    db.add(session)
    db.commit()

    return session, build_cloud_auth_url(
        redirect_uri=redirect_uri,
        state=state,
        backend_name=session.backend_name,
        backend_url=session.backend_url,
    )
