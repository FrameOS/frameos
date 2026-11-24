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
from starlette.requests import ClientDisconnect
from starlette.responses import Response
from fastapi import FastAPI, Request, Depends
from app.api.auth import get_current_user
from app.api import api_open, api_project, api_user, api_public
from app.api.project_auth import get_current_project
from fastapi.middleware.gzip import GZipMiddleware
from app.middleware import BodyCeilingMiddleware, GzipRequestMiddleware
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

# The two forms anyone can post before signing in: a few hundred bytes each.
UNAUTHENTICATED_BODY_LIMITS = {"/api/login": 64 * 1024, "/api/signup": 64 * 1024}

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware)
# Added before the gzip request middleware, so inside it: the ceiling is on
# the body as the route would read it, decompressed.
app.add_middleware(BodyCeilingMiddleware, limits=UNAUTHENTICATED_BODY_LIMITS)
app.add_middleware(GzipRequestMiddleware)
if config.HASSIO_RUN_MODE != "ingress":
    # A mutation that rides the session cookie must come from one of our own
    # pages (app/utils/same_origin.py). Under ingress the credential is Home
    # Assistant's, not our cookie, and its proxy is the only peer.
    from app.utils.same_origin import SameOriginGuard

    app.add_middleware(SameOriginGuard)
if config.HASSIO_RUN_MODE == "ingress":
    # Added last = outermost: the ingress routers carry no user auth (Home
    # Assistant does that), so nothing but the Supervisor's proxy may reach
    # them — not another add-on on the hassio network, not /ws either.
    from app.utils.ingress_guard import IngressPeerGuard

    app.add_middleware(IngressPeerGuard)

# nosniff everywhere, and who may frame the HTML (app/utils/response_headers.py).
from app.utils.response_headers import ResponseHeadersMiddleware  # noqa: E402

app.add_middleware(ResponseHeadersMiddleware)

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

# Everything the frontend build emits under a hashed filename. A request for
# one of these that misses must fail as a 404 rather than fall through to the
# SPA shell below: a browser running a bundle older than the server's (a tab
# left open across an upgrade) asks for chunk hashes this build no longer has,
# and answering those with `200 text/html` turns a plain "that file is gone"
# into "Failed to fetch dynamically imported module" at whatever import
# happened to need it first.
STATIC_ASSET_PREFIXES = ("/static/", "/assets/", "/img/", "/frameos-wasm/", "/frameos-editor/")


def is_static_asset_path(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in STATIC_ASSET_PREFIXES)


def script_json(value) -> str:
    """JSON for the inside of a `<script>` element. json.dumps alone leaves
    `</script>` and `<!--` as they are, and one of the values comes from a
    request header (`X-Ingress-Path`): escaped, the browser's HTML parser
    never sees a tag, and the JavaScript value is the same."""
    return (
        json.dumps(value)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


# The SPA shell names the hashed entrypoint it loads, so a cached copy pins the
# browser to a bundle the server may already have replaced. It is small and
# always served by us — never let it go stale.
INDEX_HTML_HEADERS = {"Cache-Control": "no-store, must-revalidate"}

# Serve HTML and static files in all cases except for public HASSIO_RUN_MODE
serve_html = config.HASSIO_RUN_MODE != "public"
if serve_html:
    # The embedded scene editor (frontend/dist-editor, the store's editor
    # without a backend): the local scenes page edits a saved scene in it,
    # in an iframe. Its live preview loads ./frameos-wasm/ next to it — the
    # built copy, else the one the dev wasm build keeps in public/. Mounted
    # whether or not they exist yet (check_dir=False): in development the
    # editor pane and the wasm pane build them after the backend starts.
    editor_wasm_dir = next(
        (d for d in ("../frontend/dist/frameos-wasm", "../frontend/public/frameos-wasm") if os.path.exists(d)),
        "../frontend/public/frameos-wasm",
    )
    app.mount(
        "/frameos-editor/frameos-wasm",
        StaticFiles(directory=editor_wasm_dir, check_dir=False),
        name="frameos-editor-wasm",
    )
    app.mount(
        "/frameos-editor",
        StaticFiles(directory="../frontend/dist-editor", html=True, check_dir=False),
        name="frameos-editor",
    )
    # only if frontend/dist exists, might not if we're using vite
    if os.path.exists("../frontend/dist"):
        app.mount("/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
        app.mount("/img", StaticFiles(directory="../frontend/dist/img"), name="img")
        app.mount("/static", StaticFiles(directory="../frontend/dist/static"), name="static")
        # wasm live-preview bundle (built by frameos/tools/build_wasm.sh into
        # frontend/public/frameos-wasm, copied into dist by the frontend build)
        if os.path.exists("../frontend/dist/frameos-wasm"):
            app.mount("/frameos-wasm", StaticFiles(directory="../frontend/dist/frameos-wasm"), name="frameos-wasm")

        try:
            index_html_template = open("../frontend/dist/index.html").read()
        except FileNotFoundError:
            if config.TEST:
                # don't need the compiled frontend when testing
                index_html_template = open("../frontend/src/index.html").read()
            else:
                raise

        def frameos_app_config(request: Request | None = None) -> dict:
            app_config: dict[str, str | int] = {}
            if config.HASSIO_RUN_MODE:
                app_config["HASSIO_RUN_MODE"] = config.HASSIO_RUN_MODE
            if config.FRAMEOS_PUBLIC_SCHEME == "https":
                # The frames' port serves TLS (the add-on's ssl option or
                # FRAMEOS_SSL_CERTFILE): a new frame's server address is https://.
                app_config["public_scheme"] = "https"
            if config.HASSIO_RUN_MODE == "ingress" and config.public_port:
                # The host port Home Assistant publishes the frames' port on
                # (8989 unless the owner changed it): the UI's links for
                # frames, kiosks and shares go there, never to the ingress.
                app_config["public_port"] = config.public_port
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
                f'<head><script>window.FRAMEOS_APP_CONFIG={script_json(frameos_app_config(request))}</script>',
            )
    else:
        dev_url = "http://localhost:8616"
        index_html_template = "<html><body><h1>Frontend not built</h1>"
        index_html_template += f'<p>Please run the frontend dev server: <a href="{dev_url}">{dev_url}</a></p>'
        index_html_template += "</body></html>"

        def index_html(request: Request | None = None) -> str:
            return index_html_template

    def index_response(request: Request | None = None) -> HTMLResponse:
        return HTMLResponse(index_html(request), headers=INDEX_HTML_HEADERS)

    @app.get("/")
    async def read_index(request: Request):
        return index_response(request)

    @app.exception_handler(StarletteHTTPException)
    async def custom_404_handler(request: Request, exc: StarletteHTTPException):
        if (
            os.environ.get("TEST") == "1"
            or exc.status_code != 404
            or request.url.path.startswith("/api")
            or is_static_asset_path(request.url.path)
        ):
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail or f"Error {exc.status_code}"},
                headers=exc.headers,
            )
        return index_response(request)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        if os.environ.get("TEST") == "1" or request.url.path.startswith("/api"):
            return await request_validation_exception_handler(request, exc)
        return index_response(request)

    @app.exception_handler(ClientDisconnect)
    async def client_disconnect_handler(request: Request, exc: ClientDisconnect):
        # The client hung up while its body streamed in (a frame's image push
        # cut short by a render, Wi-Fi going, a timeout): nobody is left to
        # answer, and it is no server error. A registered type is handled by
        # the exception middleware and not re-raised, so this skips the
        # traceback and the exception report the catch-all below would make.
        return Response(status_code=400)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        posthog_capture_exception(exc, request)
        # Starlette re-raises after this handler, so uvicorn logs the full
        # traceback; the response only echoes it in DEBUG.
        detail = (str(exc) or exc.__class__.__name__) if config.DEBUG else "Internal server error"
        return JSONResponse(status_code=500, content={"detail": detail})

if __name__ == '__main__':
    # run migrations
    if config.DEBUG:
        database_url = config.DATABASE_URL
        if database_url.startswith("sqlite:///../db/"):
            os.makedirs('../db', exist_ok=True)
    # start server
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989)
