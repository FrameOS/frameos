import logging
import asyncio
import json
from datetime import datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from fastapi import Depends, HTTPException
from fastapi.responses import FileResponse
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
    RepositoriesListResponse,
    RepositoryImageTokenResponse,
)
from app.config import config
from app.utils.jwt_tokens import create_scoped_token_response, validate_scoped_token
from . import api_with_auth, api_no_auth

FRAMEOS_SAMPLES_URL = "https://repo.frameos.net/samples/repository.json"
FRAMEOS_GALLERY_URL = "https://repo.frameos.net/gallery/repository.json"

SYSTEM_REPOSITORIES_PATH = Path(__file__).resolve().parents[3] / "repo" / "scenes"


def _system_template_subject(repository_slug: str, template_slug: str) -> str:
    return f"system-template={repository_slug}/{template_slug}"


def _load_template_definition(repository_slug: str, template_dir: Path):
    template_path = template_dir / "template.json"
    if not template_path.is_file():
        return None

    with template_path.open("r", encoding="utf-8") as template_file:
        template_data = json.load(template_file)

    image_path = template_data.get("image")
    if image_path:
        template_data["image"] = f"/api/repositories/system/{repository_slug}/templates/{template_dir.name}/image"

    scenes_reference = template_data.get("scenes")
    if isinstance(scenes_reference, str):
        scenes_path = _resolve_template_resource(template_dir, scenes_reference)
        if scenes_path and scenes_path.is_file():
            with scenes_path.open("r", encoding="utf-8") as scenes_file:
                template_data["scenes"] = json.load(scenes_file)
        else:
            template_data["scenes"] = []

    return template_data


def _resolve_template_resource(base_dir: Path, resource_path: str) -> Path | None:
    if not resource_path:
        return None

    relative_path = resource_path[2:] if resource_path.startswith("./") else resource_path
    candidate_path = (base_dir / relative_path).resolve()

    try:
        candidate_path.relative_to(base_dir.resolve())
    except ValueError:
        return None

    return candidate_path


def _load_system_repository(repository_dir: Path):
    repository_slug = repository_dir.name
    repository_metadata_path = repository_dir / "repository.json"
    metadata: dict[str, str | None] = {}
    if repository_metadata_path.is_file():
        with repository_metadata_path.open("r", encoding="utf-8") as repository_file:
            metadata = json.load(repository_file)

    templates = []
    for template_dir in sorted(path for path in repository_dir.iterdir() if path.is_dir()):
        template_definition = _load_template_definition(repository_slug, template_dir)
        if template_definition:
            templates.append(template_definition)

    return {
        "id": f"system-{repository_slug}",
        "name": metadata.get("name") or repository_slug.title(),
        "description": metadata.get("description"),
        "url": f"/api/repositories/system/{repository_slug}/repository.json",
        "last_updated_at": None,
        "templates": templates,
    }


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

@api_with_auth.get("/repositories/system", response_model=RepositoriesListResponse)
async def get_system_repositories(db: Session = Depends(get_db)):
    if not SYSTEM_REPOSITORIES_PATH.exists():
        return []

    repositories = []
    paths = [path for path in SYSTEM_REPOSITORIES_PATH.iterdir() if path.is_dir()]
    for repository_dir in paths:
        repositories.append(_load_system_repository(repository_dir))

    # Sort order: samples first, then gallery, then everything else alphabetically
    def sort_key(repo):
        if repo.get('id') == "system-samples":
            return (0, "")
        elif repo.get('id') == "system-gallery":
            return (1, "")
        return (2, repo.get('id') or "")

    repositories.sort(key=sort_key)

    return repositories


@api_with_auth.get(
    "/repositories/system/{repository_slug}/templates/{template_slug}/image_token",
    response_model=RepositoryImageTokenResponse,
)
async def get_system_repository_image_token(repository_slug: str, template_slug: str):
    return create_scoped_token_response(
        _system_template_subject(repository_slug, template_slug)
    )


@api_no_auth.get("/repositories/system/{repository_slug}/templates/{template_slug}/image")
async def get_system_repository_image(repository_slug: str, template_slug: str, token: str):
    if config.HASSIO_RUN_MODE != 'ingress':
        validate_scoped_token(
            token,
            expected_subject=_system_template_subject(repository_slug, template_slug),
        )

    repository_path = SYSTEM_REPOSITORIES_PATH / repository_slug
    if not repository_path.is_dir():
        raise HTTPException(status_code=404, detail="Repository not found")

    template_path = repository_path / template_slug
    if not template_path.is_dir():
        raise HTTPException(status_code=404, detail="Template not found")

    template_definition_path = template_path / "template.json"
    if not template_definition_path.is_file():
        raise HTTPException(status_code=404, detail="Template not found")

    with template_definition_path.open("r", encoding="utf-8") as template_file:
        template_data = json.load(template_file)

    image_reference = template_data.get("image")
    if not isinstance(image_reference, str) or not image_reference:
        raise HTTPException(status_code=404, detail="Template image not found")

    image_path = _resolve_template_resource(template_path, image_reference)
    if not image_path or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Template image not found")

    return FileResponse(image_path)

@api_with_auth.get("/repositories", response_model=RepositoriesListResponse)
async def get_repositories(db: Session = Depends(get_db)):
    try:
        if db.query(Settings).filter_by(key="@system/repository_global_cleanup").first():
            # We're good here. No need to do all the checks
            pass
        else:
            # Remove old repo if it exists
            if db.query(Settings).filter_by(key="@system/repository_init_done").first():
                old_url = "https://repo.frameos.net/versions/0/templates.json"
                repository = db.query(Repository).filter_by(url=old_url).first()
                if repository:
                    db.delete(repository)
                db.delete(db.query(Settings).filter_by(key="@system/repository_init_done").first())
                db.commit()

            # delete old gallery/samples repos
            if db.query(Settings).filter_by(key="@system/repository_samples_done").first():
                repository = db.query(Repository).filter_by(url=FRAMEOS_SAMPLES_URL).first()
                if repository:
                    db.delete(repository)
                db.delete(db.query(Settings).filter_by(key="@system/repository_samples_done").first())

            if db.query(Settings).filter_by(key="@system/repository_gallery_done").first():
                repository = db.query(Repository).filter_by(url=FRAMEOS_GALLERY_URL).first()
                if repository:
                    db.delete(repository)
                db.delete(db.query(Settings).filter_by(key="@system/repository_gallery_done").first())

            db.add(Settings(key="@system/repository_global_cleanup", value="true"))
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
