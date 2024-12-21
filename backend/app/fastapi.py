import asyncio
import os
import contextlib
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi import FastAPI, Request, Depends
from app.api.auth import get_current_user
from app.api import public_api as public_api_router, private_api as private_api_router
from fastapi.middleware.gzip import GZipMiddleware
from app.middleware import GzipRequestMiddleware
from alembic.config import Config as AlembicConfig
from alembic import command as alembic_command

from app.websockets import register_ws_routes, redis_listener
from app.config import get_config
from app.utils.sentry import initialize_sentry

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_sentry()
    task = asyncio.create_task(redis_listener())
    yield
    # optionally do cleanup here
    task.cancel()

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware)
app.add_middleware(GzipRequestMiddleware)

register_ws_routes(app)

app.include_router(public_api_router, prefix="/api")
app.include_router(private_api_router, prefix="/api", dependencies=[Depends(get_current_user)])

app.mount("/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
app.mount("/img", StaticFiles(directory="../frontend/dist/img"), name="img")
app.mount("/static", StaticFiles(directory="../frontend/dist/static"), name="static")

non_404_routes = ("/api", "/assets", "/img", "/static")

@app.get("/")
async def read_index():
    index_path = os.path.join("../frontend/dist", "index.html")
    return FileResponse(index_path)

@app.exception_handler(StarletteHTTPException)
async def custom_404_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404 and not request.url.path.startswith(non_404_routes):
        index_path = os.path.join("../frontend/dist", "index.html")
        return FileResponse(index_path)
    return JSONResponse(status_code=exc.status_code, content={"message": "Not Found" if exc.status_code == 404 else f"Error {exc.status_code}"})

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    index_path = os.path.join("../frontend/dist", "index.html")
    return FileResponse(index_path)

if __name__ == '__main__':
    # run migrations
    database_url = get_config().DATABASE_URL
    if database_url.startswith("sqlite:///../db/"):
        os.makedirs('../db', exist_ok=True)
    alembic_ini_path = os.path.join(os.path.dirname(__file__), "..", "migrations", "alembic.ini")
    alembic_cfg = AlembicConfig(alembic_ini_path)
    alembic_command.upgrade(alembic_cfg, "head")

    # start server
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989)