import pytest
import importlib

from starlette.testclient import TestClient

@pytest.fixture
def clear_env(monkeypatch):
    """
    A helper fixture to remove/clear environment variables before each test
    so each test starts from a known baseline.
    """
    monkeypatch.delenv("HASSIO_MODE", raising=False)
    monkeypatch.delenv("HASSIO_INGRESS_PATH", raising=False)


def _reload_app_and_config():
    """
    Helper that re-imports get_config and reloads app.fastapi.

    This helps ensure that changing environment variables
    re-applies to the loaded config and routes.
    """
    # Force a re-import of get_config
    from app import config
    importlib.reload(config)
    # Force a reload of the entire FastAPI module
    from app import fastapi
    importlib.reload(fastapi)
    # Return the reloaded references
    return fastapi.app, config.get_config()


@pytest.mark.asyncio
async def test_no_hassio_env(clear_env):
    """
    With no HASSIO_MODE and no HASSIO_INGRESS_PATH set,
    we expect HASSIO_MODE=None, HASSIO_INGRESS_PATH=None, and
    routes are just "/api" for the API + root HTML at "/".
    """
    app, conf = _reload_app_and_config()

    assert conf.HASSIO_MODE is None
    assert conf.HASSIO_INGRESS_PATH is None
    assert conf.base_path == ""

    client = TestClient(app)

    # /api route should work normally
    resp_api = client.get("/api/frames")
    assert resp_api.status_code != 404, "API route at /api should be accessible."

    # Root HTML
    resp_root = client.get("/")
    assert resp_root.status_code == 200, "Root HTML / should be served normally."


@pytest.mark.asyncio
async def test_hassio_mode_public(clear_env, monkeypatch):
    """
    HASSIO_MODE=public means we only mount /api/log as a 'public' router
    and do *not* serve the normal HTML routes.
    """
    monkeypatch.setenv("HASSIO_MODE", "public")

    app, conf = _reload_app_and_config()

    assert conf.HASSIO_MODE == "public"
    assert conf.HASSIO_INGRESS_PATH is None
    assert conf.base_path == ""

    client = TestClient(app)

    # The /api route is still there
    resp_api = client.get("/api/frames")
    assert resp_api.status_code == 404, "/api route should not be accessible in public mode."

    resp_api = client.post("/api/log")
    assert resp_api.status_code != 404, "/api/log route should still be accessible in public mode."

    # But the root HTML route ("/") won't be mounted.
    # We expect e.g. a 404 or similar because serve_html = False in "public" mode.
    resp_root = client.get("/")
    assert resp_root.status_code == 404, (
        "In public (ingress-public) mode, the HTML root (/) is typically not served."
    )


@pytest.mark.asyncio
async def test_hassio_mode_ingress(clear_env, monkeypatch):
    """
    HASSIO_MODE=ingress with a HASSIO_INGRESS_PATH means the 'base_path'
    is set to that path. Our APIs and HTML routes are prefixed with that base.
    """
    custom_ingress = "/my_ingress_path"
    monkeypatch.setenv("HASSIO_MODE", "ingress")
    monkeypatch.setenv("HASSIO_INGRESS_PATH", custom_ingress)

    app, conf = _reload_app_and_config()

    assert conf.HASSIO_MODE == "ingress"
    assert conf.HASSIO_INGRESS_PATH == custom_ingress
    assert conf.base_path == custom_ingress

    client = TestClient(app)

    # Check that /my_ingress_path/api is the new route
    resp_api = client.get(f"{custom_ingress}/api/frames")
    assert resp_api.status_code != 404, (
        f"Expected to find the /api routes under base_path={custom_ingress}."
    )

    # Root HTML is also served at /my_ingress_path
    resp_root = client.get(custom_ingress)
    assert resp_root.status_code == 200, "HTML root should be served at /{ingress_path} in ingress mode."

    # Check that /api (without the ingress path) returns 404
    # because in ingress mode, everything is behind the prefix
    resp_api_no_prefix = client.get("/api/frames")
    assert resp_api_no_prefix.status_code == 404, (
        "In ingress mode, /api/* should not exist without the base path prefix."
    )
