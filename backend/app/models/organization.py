from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import mapped_column, relationship

from app.database import Base


class Organization(Base):
    __tablename__ = "organization"

    id = mapped_column(Integer, primary_key=True)
    name = mapped_column(String(256), nullable=False)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    projects = relationship("Project", back_populates="organization", cascade="all, delete-orphan")
    members = relationship("OrganizationMember", back_populates="organization", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at.isoformat() if isinstance(self.created_at, datetime) else None,
        }


class OrganizationMember(Base):
    __tablename__ = "organization_member"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", name="uq_organization_member_user"),)

    id = mapped_column(Integer, primary_key=True)
    organization_id = mapped_column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False)
    user_id = mapped_column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    role = mapped_column(String(32), nullable=False, default="owner")
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    organization = relationship("Organization", back_populates="members")
    user = relationship("User", back_populates="organization_memberships")


class Project(Base):
    __tablename__ = "project"

    id = mapped_column(Integer, primary_key=True)
    organization_id = mapped_column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False)
    name = mapped_column(String(256), nullable=False)
    created_at = mapped_column(DateTime, nullable=False, default=func.current_timestamp())

    organization = relationship("Organization", back_populates="projects")

    def to_dict(self):
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "name": self.name,
            "created_at": self.created_at.isoformat() if isinstance(self.created_at, datetime) else None,
        }
