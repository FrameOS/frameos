import asyncio
import json
import os
from contextlib import asynccontextmanager
from httpx import AsyncClient, Limits
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi import FastAPI, Request, Depends
from app.api.auth import get_current_user
from app.api import api_open, api_project, api_user, api_public
from app.api.project_auth import get_current_project
from fastapi.middleware.gzip import GZipMiddleware
from app.middleware import GzipRequestMiddleware
from app.ws.remote_ws import router as remote_ws_router
from app.ws.terminal_ws import router as terminal_ws_router
from app.websockets import register_ws_routes, redis_listener
from app.config import config, normalize_ingress_path
from app.utils.posthog import initialize_posthog, capture_exception as posthog_capture_exception

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_posthog()
    app.state.http_client = AsyncClient(limits=Limits(max_connections=20, max_keepalive_connections=10))
    app.state.http_semaphore = asyncio.Semaphore(10)
    task = asyncio.create_task(redis_listener())
    yield
    await app.state.http_client.aclose()
    from app.redis import close_shared_redis
    await close_shared_redis()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware)
app.add_middleware(GzipRequestMiddleware)

register_ws_routes(app)
app.include_router(remote_ws_router)
app.include_router(terminal_ws_router)

if config.HASSIO_RUN_MODE:
    if config.HASSIO_RUN_MODE == "public":
        app.include_router(api_public, prefix="/api")
    elif config.HASSIO_RUN_MODE == "ingress":
        app.include_router(api_public, prefix="/api")
        app.include_router(api_open, prefix="/api")
        app.include_router(api_user, prefix="/api")
        app.include_router(api_project, prefix="/api/projects/{project_id}", dependencies=[Depends(get_current_project)])
    else:
        raise ValueError("Invalid HASSIO_RUN_MODE")
else:
    app.include_router(api_public, prefix="/api")
    app.include_router(api_open, prefix="/api")
    app.include_router(api_user, prefix="/api", dependencies=[Depends(get_current_user)])
    app.include_router(api_project, prefix="/api/projects/{project_id}", dependencies=[Depends(get_current_project)])

# Serve HTML and static files in all cases except for public HASSIO_RUN_MODE
serve_html = config.HASSIO_RUN_MODE != "public"
if serve_html:
    # only if frontend/dist exists, might not if we're using vite
    if os.path.exists("../frontend/dist"):
        app.mount("/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
        app.mount("/img", StaticFiles(directory="../frontend/dist/img"), name="img")
        app.mount("/static", StaticFiles(directory="../frontend/dist/static"), name="static")

        try:
            index_html_template = open("../frontend/dist/index.html").read()
        except FileNotFoundError:
            if config.TEST:
                # don't need the compiled frontend when testing
                index_html_template = open("../frontend/src/index.html").read()
            else:
                raise

        def frameos_app_config(request: Request | None = None) -> dict:
            app_config = {}
            if config.HASSIO_RUN_MODE:
                app_config["HASSIO_RUN_MODE"] = config.HASSIO_RUN_MODE
            header_ingress_path = (
                normalize_ingress_path(request.headers.get("x-ingress-path"))
                if request is not None and config.HASSIO_RUN_MODE == "ingress"
                else ""
            )
            ingress_path = header_ingress_path or config.ingress_path
            if ingress_path:
                app_config["ingress_path"] = ingress_path
            return app_config

        def index_html(request: Request | None = None) -> str:
            return index_html_template.replace(
                '<head>',
                f'<head><script>window.FRAMEOS_APP_CONFIG={json.dumps(frameos_app_config(request))}</script>',
            )
    else:
        dev_url = "http://localhost:8616"
        index_html_template = "<html><body><h1>Frontend not built</h1>"
        index_html_template += f'<p>Please run the frontend dev server: <a href="{dev_url}">{dev_url}</a></p>'
        index_html_template += "</body></html>"

        def index_html(request: Request | None = None) -> str:
            return index_html_template

    @app.get("/")
    async def read_index(request: Request):
        return HTMLResponse(index_html(request))

    @app.exception_handler(StarletteHTTPException)
    async def custom_404_handler(request: Request, exc: StarletteHTTPException):
        if os.environ.get("TEST") == "1" or exc.status_code != 404 or request.url.path.startswith("/api"):
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail or f"Error {exc.status_code}"}
            )
        return HTMLResponse(index_html(request))

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        if os.environ.get("TEST") == "1" or request.url.path.startswith("/api"):
            return await request_validation_exception_handler(request, exc)
        return HTMLResponse(index_html(request))

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        posthog_capture_exception(exc, request)
        return JSONResponse(status_code=500, content={"detail": str(exc)})

if __name__ == '__main__':
    # run migrations
    if config.DEBUG:
        database_url = config.DATABASE_URL
        if database_url.startswith("sqlite:///../db/"):
            os.makedirs('../db', exist_ok=True)
    # start server
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989)
