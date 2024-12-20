import logging
from http import HTTPStatus
from fastapi import Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlparse

from app.database import get_db
from app.models.settings import Settings
from app.models.repository import Repository
from app.utils.network import is_safe_host
from app.schemas.repositories import (
    RepositoryCreateRequest,
    RepositoryResponse,
    RepositoriesListResponse
)
from . import private_api

FRAMEOS_SAMPLES_URL = "https://repo.frameos.net/samples/repository.json"
FRAMEOS_GALLERY_URL = "https://repo.frameos.net/gallery/repository.json"

class RepositoryUpdateRequest(RepositoryCreateRequest):
    # Both fields optional for partial update
    url: str | None = None
    name: str | None = None

@private_api.post("/repositories", response_model=RepositoryResponse, status_code=201)
async def create_repository(data: RepositoryCreateRequest, db: Session = Depends(get_db)):
    url = data.url
    if not url:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Missing URL")

    if not is_safe_host(urlparse(url).hostname):
        raise HTTPException(status_code=400, detail="URL not allowed")

    try:
        new_repository = Repository(name="", url=url)
        new_repository.update_templates()  # synchronous operation
        db.add(new_repository)
        db.commit()
        db.refresh(new_repository)
        return new_repository
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@private_api.get("/repositories", response_model=RepositoriesListResponse)
async def get_repositories(db: Session = Depends(get_db)):
    try:
        # Remove old repo if it exists
        if db.query(Settings).filter_by(key="@system/repository_init_done").first():
            old_url = "https://repo.frameos.net/versions/0/templates.json"
            repository = db.query(Repository).filter_by(url=old_url).first()
            if repository:
                db.delete(repository)
            db.delete(db.query(Settings).filter_by(key="@system/repository_init_done").first())
            db.commit()

        # Create samples repo if not done
        if not db.query(Settings).filter_by(key="@system/repository_samples_done").first():
            repository = Repository(name="", url=FRAMEOS_SAMPLES_URL)
            repository.update_templates()  # synchronous
            db.add(repository)
            db.add(Settings(key="@system/repository_samples_done", value="true"))
            db.commit()

        # Create gallery repo if not done
        if not db.query(Settings).filter_by(key="@system/repository_gallery_done").first():
            repository = Repository(name="", url=FRAMEOS_GALLERY_URL)
            repository.update_templates()  # synchronous
            db.add(repository)
            db.add(Settings(key="@system/repository_gallery_done", value="true"))
            db.commit()

        repositories = db.query(Repository).all()
        return [r.to_dict() for r in repositories]
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@private_api.get("/repositories/{repository_id}", response_model=RepositoryResponse)
async def get_repository(repository_id: int, db: Session = Depends(get_db)):
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")
        repo_dict = repository.to_dict()
        return repo_dict
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@private_api.patch("/repositories/{repository_id}", response_model=RepositoryResponse)
async def update_repository(repository_id: int, data: RepositoryUpdateRequest, db: Session = Depends(get_db)):
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")

        if data.name is not None:
            repository.name = data.name
        if data.url is not None:
            repository.url = data.url
        repository.update_templates()  # synchronous
        db.commit()
        db.refresh(repository)
        return repository
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@private_api.delete("/repositories/{repository_id}")
async def delete_repository(repository_id: int, db: Session = Depends(get_db)):
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")
        db.delete(repository)
        db.commit()
        return {"message": "Repository deleted successfully"}
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")
