import logging
from http import HTTPStatus
from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlparse

from app.database import get_db
from app.models.settings import Settings
from app.models.repository import Repository
from app.utils.network import is_safe_host
from . import private_api

FRAMEOS_SAMPLES_URL = "https://repo.frameos.net/samples/repository.json"
FRAMEOS_GALLERY_URL = "https://repo.frameos.net/gallery/repository.json"

@private_api.post("/repositories")
async def create_repository(request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    url = data.get('url')

    if not url:
        return JSONResponse(content={'error': 'Missing URL'}, status_code=HTTPStatus.BAD_REQUEST)

    if not is_safe_host(urlparse(url).hostname):
        return JSONResponse(content={"error": "URL not allowed"}, status_code=400)

    try:
        new_repository = Repository(name="", url=url)
        new_repository.update_templates()  # synchronous operation
        db.add(new_repository)
        db.commit()
        return JSONResponse(content=new_repository.to_dict(), status_code=HTTPStatus.CREATED)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return JSONResponse(content={'error': 'Database error'}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)

@private_api.get("/repositories")
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

        repositories = [repo.to_json() for repo in db.query(Repository).all()]
        return JSONResponse(content=repositories, status_code=200)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return JSONResponse(content={'error': 'Database error'}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)

@private_api.get("/repositories/{repository_id}")
async def get_repository(repository_id: int, db: Session = Depends(get_db)):
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            return JSONResponse(content={"error": "Repository not found"}, status_code=HTTPStatus.NOT_FOUND)
        return JSONResponse(content=repository.to_dict(), status_code=200)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return JSONResponse(content={'error': 'Database error'}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)

@private_api.patch("/repositories/{repository_id}")
async def update_repository(repository_id: int, request: Request, db: Session = Depends(get_db)):
    data = await request.json()
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            return JSONResponse(content={"error": "Repository not found"}, status_code=HTTPStatus.NOT_FOUND)

        if data.get('name'):
            repository.name = data.get('name', repository.name)
        if data.get('url'):
            repository.url = data.get('url', repository.url)
        repository.update_templates()  # synchronous
        db.commit()
        return JSONResponse(content=repository.to_dict(), status_code=200)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return JSONResponse(content={'error': 'Database error'}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)

@private_api.delete("/repositories/{repository_id}")
async def delete_repository(repository_id: int, db: Session = Depends(get_db)):
    try:
        repository = db.query(Repository).get(repository_id)
        if not repository:
            return JSONResponse(content={"error": "Repository not found"}, status_code=HTTPStatus.NOT_FOUND)
        db.delete(repository)
        db.commit()
        return JSONResponse(content={"message": "Repository deleted successfully"}, status_code=200)
    except SQLAlchemyError as e:
        logging.error(f'Database error: {e}')
        return JSONResponse(content={'error': 'Database error'}, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)
