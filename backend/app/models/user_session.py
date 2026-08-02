"""Server-side records backing the local session cookie and bearer token.

Both credentials used to be entirely self-contained: a Fernet cookie and a JWT
carrying `{sub, exp}` and nothing else. Nothing recorded that a session
existed, so nothing could end one. Logging out only asked the browser to drop
its cookie, and revoking a cloud link — or the cloud session behind it — left
local access valid for the rest of the seven days. The only real revocation
lever was rotating SECRET_KEY, which invalidates every session on the install
and, before CLOUD_SECRET_KEY existed, silently killed the cloud link too.

Each credential now carries a `jti`, and a session is valid only while the row
for that `jti` is unrevoked and unexpired. Mirrors the cloud's `sessions`
table (cloud/packages/db/src/schema.ts).
"""
from __future__ import annotations

import datetime
import hashlib
import secrets

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, delete, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.database import Base


def new_session_id() -> str:
    """The `jti` embedded in a cookie/token. Opaque and unguessable."""
    return secrets.token_urlsafe(32)


def hash_session_id(session_id: str) -> str:
    """Stored form. The credential itself is signed or encrypted, so this is
    defence in depth: a database reader learns nothing reusable."""
    return hashlib.sha256(session_id.encode()).hexdigest()


class UserSession(Base):
    __tablename__ = "user_session"
    __table_args__ = (Index("ix_user_session_user_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    session_id_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False)
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(), nullable=False)

    def __init__(self, **kwargs):
        if "id" not in kwargs:
            kwargs["id"] = secrets.token_hex(16)
        if "created_at" not in kwargs:
            kwargs["created_at"] = datetime.datetime.utcnow()
        super().__init__(**kwargs)


def create_user_session(db: Session, *, user_id: int, expires_at: datetime.datetime) -> str:
    """Records a new session and returns the `jti` to embed in the credential."""
    session_id = new_session_id()
    db.add(
        UserSession(
            user_id=user_id,
            session_id_hash=hash_session_id(session_id),
            expires_at=expires_at,
        )
    )
    db.commit()
    return session_id


def session_is_active(db: Session, session_id: str | None) -> bool:
    if not session_id:
        return False
    row = (
        db.query(UserSession)
        .filter(UserSession.session_id_hash == hash_session_id(session_id))
        .first()
    )
    if row is None or row.revoked_at is not None:
        return False
    return row.expires_at > datetime.datetime.utcnow()


def revoke_user_session(db: Session, session_id: str | None) -> None:
    if not session_id:
        return
    db.execute(
        update(UserSession)
        .where(
            UserSession.session_id_hash == hash_session_id(session_id),
            UserSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.datetime.utcnow())
    )
    db.commit()


def revoke_sessions_for_user(db: Session, user_id: int, *, keep_session_id: str | None = None) -> None:
    """Used when the credentials behind every session change (a password
    change) or when the identity provider behind them goes away (cloud unlink).

    `keep_session_id` spares the caller's own session, which is what makes
    "change my password" end every *other* login without logging the person
    changing it out of the browser they are sitting in front of.
    """
    conditions = [UserSession.user_id == user_id, UserSession.revoked_at.is_(None)]
    if keep_session_id:
        conditions.append(UserSession.session_id_hash != hash_session_id(keep_session_id))
    db.execute(update(UserSession).where(*conditions).values(revoked_at=datetime.datetime.utcnow()))
    db.commit()


def revoke_all_sessions(db: Session) -> None:
    db.execute(update(UserSession).where(UserSession.revoked_at.is_(None)).values(revoked_at=datetime.datetime.utcnow()))
    db.commit()


def purge_expired_sessions(db: Session, *, older_than_days: int = 7) -> None:
    """Rows outlive their usefulness the moment they expire; keep a short tail
    so an operator can still see recent sessions, then drop them."""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=older_than_days)
    db.execute(delete(UserSession).where(UserSession.expires_at < cutoff))
    db.commit()
