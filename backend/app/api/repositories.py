import logging
import asyncio
from datetime import datetime, timedelta
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
    RepositoryUpdateRequest,
    RepositoryResponse,
    RepositoriesListResponse
)
from . import api_with_auth

FRAMEOS_SAMPLES_URL = "https://repo.frameos.net/samples/repository.json"
FRAMEOS_GALLERY_URL = "https://repo.frameos.net/gallery/repository.json"


@api_with_auth.post("/repositories", response_model=RepositoryResponse, status_code=201)
async def create_repository(data: RepositoryCreateRequest, db: Session = Depends(get_db)):
    url = data.url
    if not url:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Missing URL")

    hostname = urlparse(url).hostname
    if not hostname or not is_safe_host(hostname):
        raise HTTPException(status_code=400, detail="URL not allowed")

    try:
        new_repository = Repository(name="", url=url)
        await new_repository.update_templates()
        db.add(new_repository)
        db.commit()
        db.refresh(new_repository)
        return new_repository
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@api_with_auth.get("/repositories", response_model=RepositoriesListResponse)
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
            await repository.update_templates()
            db.add(repository)
            db.add(Settings(key="@system/repository_samples_done", value="true"))
            db.commit()

        # Create gallery repo if not done
        if not db.query(Settings).filter_by(key="@system/repository_gallery_done").first():
            repository = Repository(name="", url=FRAMEOS_GALLERY_URL)
            await repository.update_templates()
            db.add(repository)
            db.add(Settings(key="@system/repository_gallery_done", value="true"))
            db.commit()

        repositories = db.query(Repository).all()

        for r in repositories:
            # if haven't refreshed in a day
            if not r.last_updated_at or r.last_updated_at < datetime.utcnow() - timedelta(seconds=86400):
                # schedule updates in the background
                asyncio.create_task(r.update_templates())

        return [r.to_dict() for r in repositories]
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@api_with_auth.get("/repositories/{repository_id}", response_model=RepositoryResponse)
async def get_repository(repository_id: str, db: Session = Depends(get_db)):
    try:
        repository = db.get(Repository, repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")
        repo_dict = repository.to_dict()
        return repo_dict
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@api_with_auth.patch("/repositories/{repository_id}", response_model=RepositoryResponse)
async def update_repository(repository_id: str, data: RepositoryUpdateRequest, db: Session = Depends(get_db)):
    try:
        repository = db.get(Repository, repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")

        if data.name is not None:
            repository.name = data.name
        if data.url is not None:
            repository.url = data.url
        await repository.update_templates()
        db.commit()
        db.refresh(repository)
        return repository
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")

@api_with_auth.delete("/repositories/{repository_id}")
async def delete_repository(repository_id: str, db: Session = Depends(get_db)):
    try:
        repository = db.get(Repository, repository_id)
        if not repository:
            raise HTTPException(status_code=404, detail="Repository not found")
        db.delete(repository)
        db.commit()
        return {"message": "Repository deleted successfully"}
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        raise HTTPException(status_code=500, detail="Database error")
