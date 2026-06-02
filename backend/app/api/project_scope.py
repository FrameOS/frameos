from http import HTTPStatus
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.tenancy import ProjectContext, current_project_context


def project_query(db: Session, model: Any, context: ProjectContext | None = None):
    context = context or current_project_context()
    return db.query(model).filter(model.project_id == context.project_id)


def project_get(db: Session, model: Any, object_id: Any, context: ProjectContext | None = None):
    return project_query(db, model, context).filter(model.id == object_id).first()


def project_get_or_404(
    db: Session,
    model: Any,
    object_id: Any,
    *,
    detail: str,
    context: ProjectContext | None = None,
):
    instance = project_get(db, model, object_id, context)
    if instance is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=detail)
    return instance
