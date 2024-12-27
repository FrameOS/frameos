import asyncio
import json
import os
import contextlib
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi import FastAPI, Request, Depends
from app.api.auth import get_current_user
from app.api import api_no_auth, api_with_auth, api_public
from fastapi.middleware.gzip import GZipMiddleware
from app.middleware import GzipRequestMiddleware

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

config = get_config()

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware)
app.add_middleware(GzipRequestMiddleware)

register_ws_routes(app)

if config.HASSIO_MODE:
    if config.HASSIO_MODE == "public":
        app.include_router(api_public, prefix="/api")
    elif config.HASSIO_MODE == "ingress":
        app.include_router(api_public, prefix=config.base_path + "/api")
        app.include_router(api_no_auth, prefix=config.base_path + "/api")
        app.include_router(api_with_auth, prefix=config.base_path + "/api")
    else:
        raise ValueError("Invalid HASSIO_MODE")
else:
    app.include_router(api_public, prefix="/api")
    app.include_router(api_no_auth, prefix="/api")
    app.include_router(api_with_auth, prefix="/api", dependencies=[Depends(get_current_user)])

# Serve HTML and static files in all cases except for public HASSIO_MODE
serve_html = config.HASSIO_MODE != "public"
if serve_html:
    app.mount(config.base_path + "/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
    app.mount(config.base_path + "/img", StaticFiles(directory="../frontend/dist/img"), name="img")
    app.mount(config.base_path + "/static", StaticFiles(directory="../frontend/dist/static"), name="static")

    # Public config for the frontend
    frameos_app_config = {}
    index_html = open("../frontend/dist/index.html").read()
    if config.HASSIO_MODE:
        frameos_app_config["HASSIO_MODE"] = config.HASSIO_MODE
    if config.base_path:
        frameos_app_config["base_path"] = config.base_path
        index_html = index_html.replace('<base href="/">', f'<base href="{config.base_path}/">')
    index_html = index_html.replace('<head>', f'<head><script>window.FRAMEOS_APP_CONFIG={json.dumps(frameos_app_config)}</script>')

    @app.get(config.base_path + "/")
    async def read_index():
        return HTMLResponse(index_html)

    if config.base_path:
        @app.get(config.base_path)
        async def read_index():
            return HTMLResponse(index_html)

    @app.exception_handler(StarletteHTTPException)
    async def custom_404_handler(request: Request, exc: StarletteHTTPException):
        if os.environ.get("TEST") == "1" or exc.status_code != 404 or (config.base_path and not request.url.path.startswith(config.base_path)):
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail or f"Error {exc.status_code}"}
            )
        return HTMLResponse(index_html)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        if os.environ.get("TEST") == "1":
            return JSONResponse(
                status_code=422,
                content={"detail": exc.errors()}
            )
        return HTMLResponse(index_html)

if __name__ == '__main__':
    # run migrations
    if get_config().DEBUG:
        database_url = get_config().DATABASE_URL
        if database_url.startswith("sqlite:///../db/"):
            os.makedirs('../db', exist_ok=True)
    # start server
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989)