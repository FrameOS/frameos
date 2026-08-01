from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Session, mapped_column, relationship

from app.database import Base


class CloudIdentity(Base):
    """A local user linked to a FrameOS Cloud account (used from Phase 1 on)."""

    __tablename__ = "cloud_identity"
    __table_args__ = (
        UniqueConstraint("provider_issuer", "provider_subject", name="uq_cloud_identity_provider_subject"),
    )

    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)
    provider_url = mapped_column(String(512), nullable=False)
    provider_issuer = mapped_column(String(512), nullable=False)
    provider_subject = mapped_column(String(512), nullable=False)
    cloud_account_id = mapped_column(String(128), nullable=True, index=True)
    email = mapped_column(String(256), nullable=True)
    email_verified = mapped_column(Boolean, nullable=False, default=False)
    name = mapped_column(String(256), nullable=True)
    last_login_at = mapped_column(DateTime, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    updated_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    user = relationship("User")


class CloudBackendLink(Base):
    """This installation's link to a FrameOS Cloud provider. One row per install."""

    __tablename__ = "cloud_backend_link"

    id = mapped_column(Integer, primary_key=True)
    provider_url = mapped_column(String(512), nullable=False)
    provider_issuer = mapped_column(String(512), nullable=True)
    status = mapped_column(String(32), nullable=False, default="disconnected")
    public_display_name = mapped_column(String(256), nullable=True)
    local_origin = mapped_column(String(512), nullable=True)
    device_code = mapped_column(String(2048), nullable=True)
    user_code = mapped_column(String(64), nullable=True)
    verification_uri = mapped_column(String(1024), nullable=True)
    verification_uri_complete = mapped_column(String(1024), nullable=True)
    expires_at = mapped_column(DateTime, nullable=True)
    interval_seconds = mapped_column(Integer, nullable=False, default=5)
    poll_error = mapped_column(String(128), nullable=True)
    # Encrypted with Fernet keyed off SECRET_KEY; never returned by the API.
    access_token = mapped_column(String(4096), nullable=True)
    token_reference = mapped_column(String(256), nullable=True)
    linked_client_id = mapped_column(String(128), nullable=True)
    cloud_account_id = mapped_column(String(128), nullable=True)
    cloud_account_email = mapped_column(String(256), nullable=True)
    cloud_organization_id = mapped_column(String(128), nullable=True)
    cloud_project_id = mapped_column(String(128), nullable=True)
    scope = mapped_column(String(1024), nullable=True)
    local_organization_id = mapped_column(Integer, ForeignKey("organization.id", ondelete="SET NULL"), nullable=True)
    local_project_id = mapped_column(Integer, ForeignKey("project.id", ondelete="SET NULL"), nullable=True)
    local_fallback_enabled = mapped_column(Boolean, nullable=False, default=True)
    last_inventory_sync_at = mapped_column(DateTime, nullable=True)
    last_grant_sync_at = mapped_column(DateTime, nullable=True)
    revoked_at = mapped_column(DateTime, nullable=True)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    updated_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    memberships = relationship("CloudMembership", back_populates="backend_link", cascade="all, delete-orphan")

    @property
    def scopes(self) -> list[str]:
        return (self.scope or "").split() if self.scope else []


class CloudMembership(Base):
    """Cloud-side access grants synced onto this backend (used from Phase 1 on)."""

    __tablename__ = "cloud_membership"
    __table_args__ = (
        UniqueConstraint(
            "backend_link_id",
            "cloud_account_id",
            "cloud_organization_id",
            "cloud_project_id",
            name="uq_cloud_membership_grant",
        ),
    )

    id = mapped_column(Integer, primary_key=True)
    backend_link_id = mapped_column(Integer, ForeignKey("cloud_backend_link.id", ondelete="CASCADE"), nullable=False)
    cloud_account_id = mapped_column(String(128), nullable=False, index=True)
    cloud_organization_id = mapped_column(String(128), nullable=False)
    cloud_project_id = mapped_column(String(128), nullable=True)
    role = mapped_column(String(32), nullable=False)
    local_organization_id = mapped_column(Integer, ForeignKey("organization.id", ondelete="SET NULL"), nullable=True)
    local_project_id = mapped_column(Integer, ForeignKey("project.id", ondelete="SET NULL"), nullable=True)
    updated_at = mapped_column(DateTime, nullable=True)
    synced_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    backend_link = relationship("CloudBackendLink", back_populates="memberships")


def current_cloud_backend_link(db: Session) -> CloudBackendLink | None:
    return db.query(CloudBackendLink).order_by(CloudBackendLink.id.desc()).first()


def link_is_expired(link: CloudBackendLink, now: datetime) -> bool:
    return link.status == "connecting" and link.expires_at is not None and link.expires_at <= now
