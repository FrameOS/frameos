"""Personal API tokens: the user, as a bearer.

A token stands in for its owner on every route a session cookie or login
JWT opens — and on the MCP server at `POST /api/mcp`, which is what they are
for: a script or an AI agent driving the frames without a browser. Mirrors
the cloud's `account_api_tokens` (cloud/docs/mcp.md): shown once, stored
hashed, told apart by prefix so a read-only token is refused for a mutation
before any database work.

- `fb_api_…`    may do everything its owner may (full access).
- `fb_apiro_…`  only GET/HEAD/OPTIONS (read-only).

The database row stays the authority: a forged prefix buys nothing, the
`access` column is checked again on every request.

What a token can never do: mint another token, change the account's email or
password (those read the session cookie's credentials — `require_session`),
or log in to the web UI.
"""
from __future__ import annotations

import datetime
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.database import Base

__all__ = [
    "API_TOKEN_ACCESS_VALUES",
    "API_TOKEN_PREFIX",
    "API_TOKEN_READ_ONLY_PREFIX",
    "DEFAULT_API_TOKEN_TTL_DAYS",
    "MAX_API_TOKENS_PER_USER",
    "MAX_API_TOKEN_NAME_LENGTH",
    "MAX_API_TOKEN_TTL_DAYS",
    "ApiToken",
    "ApiTokenIdentity",
    "api_token_access_from_prefix",
    "api_token_hint",
    "authenticate_api_token",
    "count_live_api_tokens",
    "create_api_token",
    "hash_api_token",
    "is_api_token",
    "list_api_tokens",
    "mint_api_token",
    "revoke_api_token",
    "revoke_api_tokens_for_user",
]

API_TOKEN_PREFIX = "fb_api"
API_TOKEN_READ_ONLY_PREFIX = "fb_apiro"
API_TOKEN_ACCESS_VALUES = ("full", "read_only")

MAX_API_TOKENS_PER_USER = 25
MAX_API_TOKEN_NAME_LENGTH = 64
MAX_API_TOKEN_TTL_DAYS = 365
# Every token expires. Ninety days is long enough for a script in actual use
# (its owner re-mints from the settings page) and short enough that a
# forgotten one dies on its own.
DEFAULT_API_TOKEN_TTL_DAYS = 90

# `last_used_at` is "is this token still in use", not an access log.
LAST_USED_WRITE_INTERVAL = datetime.timedelta(minutes=1)


class ApiToken(Base):
    __tablename__ = "api_token"
    __table_args__ = (Index("ix_api_token_user_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(MAX_API_TOKEN_NAME_LENGTH), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # Prefix plus the first four random characters, for telling tokens apart
    # in a list without storing anything reusable.
    hint: Mapped[str] = mapped_column(String(32), nullable=False)
    access: Mapped[str] = mapped_column(String(16), nullable=False, default="full")
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False)
    last_used_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(), nullable=True)
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False)

    def __init__(self, **kwargs):
        if "id" not in kwargs:
            kwargs["id"] = secrets.token_hex(16)
        if "created_at" not in kwargs:
            kwargs["created_at"] = datetime.datetime.utcnow()
        super().__init__(**kwargs)

    @property
    def is_live(self) -> bool:
        return self.revoked_at is None and self.expires_at > datetime.datetime.utcnow()

    def to_dict(self) -> dict:
        def iso(value: datetime.datetime | None) -> str | None:
            return value.replace(tzinfo=datetime.timezone.utc).isoformat() if value else None

        return {
            "id": self.id,
            "name": self.name,
            "hint": self.hint,
            "access": self.access,
            "expires_at": iso(self.expires_at),
            "last_used_at": iso(self.last_used_at),
            "revoked_at": iso(self.revoked_at),
            "created_at": iso(self.created_at),
        }


@dataclass(frozen=True)
class ApiTokenIdentity:
    """What a request authenticated with a token knows about it."""

    id: str
    name: str
    access: str

    @property
    def read_only(self) -> bool:
        return self.access == "read_only"


def hash_api_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def is_api_token(token: str | None) -> bool:
    return isinstance(token, str) and (
        token.startswith(f"{API_TOKEN_PREFIX}_") or token.startswith(f"{API_TOKEN_READ_ONLY_PREFIX}_")
    )


def api_token_access_from_prefix(token: str) -> str:
    return "read_only" if token.startswith(f"{API_TOKEN_READ_ONLY_PREFIX}_") else "full"


def api_token_hint(token: str) -> str:
    prefix = API_TOKEN_READ_ONLY_PREFIX if token.startswith(f"{API_TOKEN_READ_ONLY_PREFIX}_") else API_TOKEN_PREFIX
    return token[: len(prefix) + 1 + 4]


def mint_api_token(access: str) -> tuple[str, str, str]:
    """Returns (token, token_hash, hint). The token itself is shown once."""
    prefix = API_TOKEN_READ_ONLY_PREFIX if access == "read_only" else API_TOKEN_PREFIX
    token = f"{prefix}_{secrets.token_urlsafe(32)}"
    return token, hash_api_token(token), api_token_hint(token)


def count_live_api_tokens(db: Session, user_id: int) -> int:
    now = datetime.datetime.utcnow()
    return (
        db.query(ApiToken)
        .filter(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None), ApiToken.expires_at > now)
        .count()
    )


def create_api_token(
    db: Session,
    *,
    user_id: int,
    name: str,
    access: str,
    expires_in_days: int,
) -> tuple[str, ApiToken]:
    if access not in API_TOKEN_ACCESS_VALUES:
        raise ValueError("access must be 'full' or 'read_only'")
    token, token_hash, hint = mint_api_token(access)
    row = ApiToken(
        user_id=user_id,
        name=name,
        token_hash=token_hash,
        hint=hint,
        access=access,
        expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=expires_in_days),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return token, row


def list_api_tokens(db: Session, user_id: int) -> list[ApiToken]:
    """Live tokens plus the ones revoked or expired in the last week, so the
    list explains a script that stopped working."""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=7)
    rows = (
        db.query(ApiToken)
        .filter(ApiToken.user_id == user_id)
        .order_by(ApiToken.created_at.desc(), ApiToken.id.desc())
        .all()
    )
    return [
        row
        for row in rows
        if row.is_live or (row.revoked_at and row.revoked_at > cutoff) or (row.expires_at > cutoff)
    ]


def revoke_api_token(db: Session, *, user_id: int, token_id: str) -> bool:
    """True when a live token of this user was revoked by this call."""
    result = cast(
        CursorResult[Any],
        db.execute(
            update(ApiToken)
            .where(ApiToken.id == token_id, ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
            .values(revoked_at=datetime.datetime.utcnow())
        ),
    )
    db.commit()
    return bool(result.rowcount)


def revoke_api_tokens_for_user(db: Session, user_id: int) -> int:
    result = cast(
        CursorResult[Any],
        db.execute(
            update(ApiToken)
            .where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
            .values(revoked_at=datetime.datetime.utcnow())
        ),
    )
    db.commit()
    return int(result.rowcount or 0)


def authenticate_api_token(db: Session, token: str) -> tuple[int, ApiTokenIdentity] | None:
    """Resolves a raw bearer to (user_id, identity), or None for anything
    that is not a live token of the kind its prefix claims. Stamps
    `last_used_at` (throttled) as a side effect."""
    if not is_api_token(token):
        return None
    row = db.query(ApiToken).filter(ApiToken.token_hash == hash_api_token(token)).first()
    if row is None or not row.is_live:
        return None
    # The row is the authority: a `fb_api_` token whose row says read_only
    # is read-only, and a `fb_apiro_` token whose row says full is refused
    # outright — the prefix and the row disagree, so something was forged.
    if row.access != api_token_access_from_prefix(token):
        return None
    now = datetime.datetime.utcnow()
    if row.last_used_at is None or now - row.last_used_at > LAST_USED_WRITE_INTERVAL:
        row.last_used_at = now
        db.commit()
    return row.user_id, ApiTokenIdentity(id=row.id, name=row.name, access=row.access)
