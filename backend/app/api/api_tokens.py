"""Personal API tokens (app/models/api_token.py): list, mint, revoke.

Managed on Settings → API tokens and MCP. Minting needs a browser session —
never a token — and the current password when the account has one, because
it turns a session into a durable credential. The secret is returned once.
"""
from __future__ import annotations

from http import HTTPStatus

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app import config as app_config
from app.api.auth import get_current_user_from_request, request_api_token, require_session_credential
from app.database import get_db
from app.models.api_token import (
    DEFAULT_API_TOKEN_TTL_DAYS,
    MAX_API_TOKEN_TTL_DAYS,
    MAX_API_TOKENS_PER_USER,
    count_live_api_tokens,
    create_api_token,
    list_api_tokens,
    revoke_api_token,
)
from app.models.user import User
from app.schemas.api_tokens import ApiTokenCreateRequest, ApiTokenCreateResponse, ApiTokensListResponse
from app.utils.public_origin import mcp_url

from . import api_user


async def _require_local_user(request: Request, db: Session) -> User:
    if app_config.config.HASSIO_RUN_MODE is not None:
        raise HTTPException(
            status_code=HTTPStatus.UNAUTHORIZED,
            detail="API tokens are not available with HASSIO_RUN_MODE: Home Assistant owns the login.",
        )
    user = await get_current_user_from_request(request, db)
    if user is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Could not validate credentials")
    return user


@api_user.get("/user/api_tokens", response_model=ApiTokensListResponse)
async def api_tokens_list(request: Request, db: Session = Depends(get_db)):
    user = await _require_local_user(request, db)
    return {
        "api_tokens": [row.to_dict() for row in list_api_tokens(db, user.id)],
        "live_count": count_live_api_tokens(db, user.id),
        "max_tokens": MAX_API_TOKENS_PER_USER,
        "default_ttl_days": DEFAULT_API_TOKEN_TTL_DAYS,
        "max_ttl_days": MAX_API_TOKEN_TTL_DAYS,
        "can_create": request_api_token(request) is None,
        "mcp_url": mcp_url(request),
    }


@api_user.post("/user/api_tokens", response_model=ApiTokenCreateResponse, status_code=HTTPStatus.CREATED)
async def api_tokens_create(data: ApiTokenCreateRequest, request: Request, db: Session = Depends(get_db)):
    user = await _require_local_user(request, db)
    require_session_credential(request)
    # Same rule as the password change: a cloud-created user has no local
    # password, and is already authenticated here.
    if user.password:
        if not data.current_password:
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Current password is required.")
        if not user.check_password(data.current_password):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Current password is incorrect.")
    if count_live_api_tokens(db, user.id) >= MAX_API_TOKENS_PER_USER:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail=f"You already have {MAX_API_TOKENS_PER_USER} live API tokens. Revoke one first.",
        )
    token, row = create_api_token(
        db,
        user_id=user.id,
        name=data.name,
        access=data.access,
        expires_in_days=data.expires_in_days or DEFAULT_API_TOKEN_TTL_DAYS,
    )
    return {"token": token, "api_token": row.to_dict()}


@api_user.delete("/user/api_tokens/{token_id}")
async def api_tokens_revoke(token_id: str, request: Request, db: Session = Depends(get_db)):
    user = await _require_local_user(request, db)
    # A token may revoke itself (and any sibling): revocation only ever
    # narrows what a leaked credential can do.
    if not revoke_api_token(db, user_id=user.id, token_id=token_id):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="No live API token with that id")
    return {"message": "API token revoked", "id": token_id}
