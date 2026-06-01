from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session
from starlette import status

from app.api.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.tenancy import ProjectContext, get_user_project, reset_current_project_context, set_current_project_context


async def get_current_project(
    request: Request,
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = get_user_project(db, current_user, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    context = ProjectContext(project=project, organization=project.organization, user=current_user)
    token = set_current_project_context(context)
    request.state.project = context
    try:
        yield context
    finally:
        reset_current_project_context(token)
