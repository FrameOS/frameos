from fastapi import Depends
from sqlalchemy.orm import Session

from app.api import api_user
from app import config as app_config
from app.database import get_db
from app.models.organization import OrganizationMember, Project
from app.models.user import User
from app.api.project_auth import get_current_project
from app.schemas.projects import ProjectResponse, ProjectsListResponse
from app.tenancy import ProjectContext, ensure_default_project, ensure_default_project_for_user

from .auth import get_current_user


def _project_response(project: Project) -> ProjectResponse:
    return ProjectResponse(
        id=project.id,
        name=project.name,
        organization={
            "id": project.organization.id,
            "name": project.organization.name,
        },
    )


@api_user.get("/projects", response_model=ProjectsListResponse)
async def list_projects(
    current_user: User | None = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if app_config.config.HASSIO_RUN_MODE == "ingress":
        ensure_default_project(db)
        projects = db.query(Project).order_by(Project.id.asc()).all()
        return ProjectsListResponse(projects=[_project_response(project) for project in projects])

    assert current_user is not None
    ensure_default_project_for_user(db, current_user)
    projects = (
        db.query(Project)
        .join(OrganizationMember, OrganizationMember.organization_id == Project.organization_id)
        .filter(OrganizationMember.user_id == current_user.id)
        .order_by(Project.id.asc())
        .all()
    )
    return ProjectsListResponse(projects=[_project_response(project) for project in projects])


@api_user.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(context: ProjectContext = Depends(get_current_project)):
    return _project_response(context.project)
