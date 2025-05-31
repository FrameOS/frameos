import asyncio
import json
import os
from contextlib import asynccontextmanager, suppress
from httpx import AsyncClient, Limits
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi import FastAPI, Request, Depends
from app.api.auth import get_current_user
from app.api import api_no_auth, api_with_auth, api_public
from fastapi.middleware.gzip import GZipMiddleware
from app.middleware import GzipRequestMiddleware
from app.ws.agent_ws import router as agent_ws_router
from app.ws.agent_tasks import start_background_listener
from app.redis import create_redis_connection
from app.websockets import register_ws_routes, redis_listener
from app.config import config
from app.utils.sentry import initialize_sentry

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_sentry()
    app.state.http_client = AsyncClient(limits=Limits(max_connections=20, max_keepalive_connections=10))
    app.state.http_semaphore = asyncio.Semaphore(10)
    app.state.redis = create_redis_connection()
    task = asyncio.create_task(redis_listener())
    start_background_listener(app)
    yield
    await app.state.http_client.aclose()
    task.cancel()
    with suppress(Exception):
        await app.state.redis.close()

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware)
app.add_middleware(GzipRequestMiddleware)

register_ws_routes(app)
app.include_router(agent_ws_router)

if config.HASSIO_RUN_MODE:
    if config.HASSIO_RUN_MODE == "public":
        app.include_router(api_public, prefix="/api")
    elif config.HASSIO_RUN_MODE == "ingress":
        app.include_router(api_public, prefix="/api")
        app.include_router(api_no_auth, prefix="/api")
        app.include_router(api_with_auth, prefix="/api")
    else:
        raise ValueError("Invalid HASSIO_RUN_MODE")
else:
    app.include_router(api_public, prefix="/api")
    app.include_router(api_no_auth, prefix="/api")
    app.include_router(api_with_auth, prefix="/api", dependencies=[Depends(get_current_user)])

# Serve HTML and static files in all cases except for public HASSIO_RUN_MODE
serve_html = config.HASSIO_RUN_MODE != "public"
if serve_html:
    app.mount("/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
    app.mount("/img", StaticFiles(directory="../frontend/dist/img"), name="img")
    app.mount("/static", StaticFiles(directory="../frontend/dist/static"), name="static")

    # Public config for the frontend
    frameos_app_config = {}
    try:
        index_html = open("../frontend/dist/index.html").read()
    except FileNotFoundError:
        if config.TEST:
            # don't need the compiled frontend when testing
            index_html = open("../frontend/src/index.html").read()
        else:
            raise

    if config.HASSIO_RUN_MODE:
        frameos_app_config["HASSIO_RUN_MODE"] = config.HASSIO_RUN_MODE
    if config.ingress_path:
        frameos_app_config["ingress_path"] = config.ingress_path

    index_html = index_html.replace('<head>', f'<head><script>window.FRAMEOS_APP_CONFIG={json.dumps(frameos_app_config)}</script>')

    @app.get("/")
    async def read_index():
        return HTMLResponse(index_html)

    @app.exception_handler(StarletteHTTPException)
    async def custom_404_handler(request: Request, exc: StarletteHTTPException):
        if os.environ.get("TEST") == "1" or exc.status_code != 404 or request.url.path.startswith("/api"):
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
    if config.DEBUG:
        database_url = config.DATABASE_URL
        if database_url.startswith("sqlite:///../db/"):
            os.makedirs('../db', exist_ok=True)
    # start server
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989)