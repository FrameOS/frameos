from __future__ import annotations

from dataclasses import dataclass
from contextvars import ContextVar, Token

from sqlalchemy.orm import Session

from app.models.organization import Organization, OrganizationMember, Project
from app.models.user import User

DEFAULT_ORGANIZATION_NAME = "Default Organization"
DEFAULT_PROJECT_NAME = "Default Project"
_current_project_context: ContextVar[ProjectContext | None] = ContextVar("current_project_context", default=None)


@dataclass(frozen=True)
class ProjectContext:
    project: Project
    organization: Organization
    user: User | None

    @property
    def project_id(self) -> int:
        return int(self.project.id)

    @property
    def organization_id(self) -> int:
        return int(self.organization.id)


def ensure_default_project_for_user(db: Session, user: User) -> Project:
    membership = (
        db.query(OrganizationMember)
        .filter(OrganizationMember.user_id == user.id)
        .order_by(OrganizationMember.id.asc())
        .first()
    )
    if membership:
        project = (
            db.query(Project)
            .filter(Project.organization_id == membership.organization_id)
            .order_by(Project.id.asc())
            .first()
        )
        if project:
            return project

    existing_project = (
        db.query(Project)
        .outerjoin(OrganizationMember, OrganizationMember.organization_id == Project.organization_id)
        .filter(OrganizationMember.id.is_(None))
        .order_by(Project.id.asc())
        .first()
    )
    if existing_project:
        db.add(OrganizationMember(organization_id=existing_project.organization_id, user_id=user.id, role="owner"))
        db.commit()
        db.refresh(existing_project)
        return existing_project

    organization = Organization(name=DEFAULT_ORGANIZATION_NAME)
    db.add(organization)
    db.flush()

    db.add(OrganizationMember(organization_id=organization.id, user_id=user.id, role="owner"))
    project = Project(organization_id=organization.id, name=DEFAULT_PROJECT_NAME)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def ensure_default_project(db: Session) -> Project:
    project = db.query(Project).order_by(Project.id.asc()).first()
    if project:
        return project

    organization = Organization(name=DEFAULT_ORGANIZATION_NAME)
    db.add(organization)
    db.flush()

    project = Project(organization_id=organization.id, name=DEFAULT_PROJECT_NAME)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def get_user_project(db: Session, user: User, project_id: int) -> Project | None:
    return (
        db.query(Project)
        .join(OrganizationMember, OrganizationMember.organization_id == Project.organization_id)
        .filter(Project.id == project_id, OrganizationMember.user_id == user.id)
        .first()
    )


def set_current_project_context(context: ProjectContext) -> Token:
    return _current_project_context.set(context)


def reset_current_project_context(token: Token) -> None:
    _current_project_context.reset(token)


def current_project_context() -> ProjectContext:
    context = _current_project_context.get()
    if context is None:
        raise RuntimeError("No project context is active")
    return context


def current_project_id() -> int:
    return current_project_context().project_id


def filter_project(query, model, project: ProjectContext):
    return query.filter(model.project_id == project.project_id)
