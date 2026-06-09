from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Session, mapped_column, relationship

from app.database import Base


class CloudIdentity(Base):
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

    user = relationship("User", back_populates="cloud_identities")


class CloudBackendLink(Base):
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
    access_token = mapped_column(String(4096), nullable=True)
    token_reference = mapped_column(String(256), nullable=True)
    linked_client_id = mapped_column(String(128), nullable=True)
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

    def to_public_dict(self) -> dict:
        return {
            "status": self.status,
            "provider_url": self.provider_url,
            "provider_issuer": self.provider_issuer,
            "user_code": self.user_code,
            "verification_uri": self.verification_uri,
            "verification_uri_complete": self.verification_uri_complete,
            "expires_at": self.expires_at.isoformat() if isinstance(self.expires_at, datetime) else None,
            "interval_seconds": self.interval_seconds,
            "poll_error": self.poll_error,
            "token_reference": self.token_reference,
            "linked_client_id": self.linked_client_id,
            "cloud_organization_id": self.cloud_organization_id,
            "cloud_project_id": self.cloud_project_id,
            "local_project_id": self.local_project_id,
            "local_organization_id": self.local_organization_id,
            "local_fallback_enabled": self.local_fallback_enabled,
            "last_inventory_sync_at": self.last_inventory_sync_at.isoformat()
            if isinstance(self.last_inventory_sync_at, datetime)
            else None,
            "last_grant_sync_at": self.last_grant_sync_at.isoformat()
            if isinstance(self.last_grant_sync_at, datetime)
            else None,
            "revoked_at": self.revoked_at.isoformat() if isinstance(self.revoked_at, datetime) else None,
        }


class CloudMembership(Base):
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

    def to_dict(self) -> dict:
        return {
            "cloud_account_id": self.cloud_account_id,
            "cloud_organization_id": self.cloud_organization_id,
            "cloud_project_id": self.cloud_project_id,
            "role": self.role,
            "local_organization_id": self.local_organization_id,
            "local_project_id": self.local_project_id,
            "updated_at": self.updated_at.isoformat() if isinstance(self.updated_at, datetime) else None,
            "synced_at": self.synced_at.isoformat() if isinstance(self.synced_at, datetime) else None,
        }


def current_cloud_backend_link(db: Session) -> CloudBackendLink | None:
    return db.query(CloudBackendLink).order_by(CloudBackendLink.id.desc()).first()


def local_fallback_enabled(db: Session) -> bool:
    link = current_cloud_backend_link(db)
    return link is None or link.local_fallback_enabled is not False
