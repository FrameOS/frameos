import pytest
import importlib
from starlette.testclient import TestClient
from unittest.mock import patch

from app.conftest import MockResponse

@pytest.fixture
def clear_env(monkeypatch):
    """
    A helper fixture to remove/clear environment variables before each test
    so each test starts from a known baseline.
    """
    monkeypatch.delenv("HASSIO_RUN_MODE", raising=False)
    monkeypatch.delenv("HASSIO_TOKEN", raising=False)

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
    return fastapi.app, config.config

@pytest.mark.asyncio
async def test_no_hassio_env(clear_env):
    """
    With no HASSIO_RUN_MODE and no HASSIO_TOKEN set,
    we expect normal Docker mode:
      - /api/frames => requires auth (part of api_with_auth).
      - /api/has_first_user => no auth needed (part of api_no_auth).
      - Root HTML => served at "/".
    """
    app, conf = _reload_app_and_config()
    assert conf.HASSIO_TOKEN is None
    assert conf.HASSIO_RUN_MODE is None
    assert conf.base_path == ""

    client = TestClient(app)

    # 1. /api/has_first_user => belongs to api_no_auth => no token required => 200 OK
    resp_no_auth = client.get("/api/has_first_user")
    assert resp_no_auth.status_code == 200, "Expected /api/has_first_user to be accessible without token."

    # 2. /api/frames => belongs to api_with_auth => must have token => should 401 if missing
    resp_auth_needed = client.get("/api/frames")
    assert resp_auth_needed.status_code == 401, "Expected /api/frames to require auth in non-HASSIO mode."

    # 3. Root HTML is served
    resp_root = client.get("/")
    assert resp_root.status_code == 200, "Expected root HTML at / in normal Docker mode."

@pytest.mark.asyncio
async def test_hassio_run_mode_public(clear_env, monkeypatch):
    """
    HASSIO_RUN_MODE=public means we only mount api_public (here: /api/log in your code).
    Anything from api_no_auth or api_with_auth should be absent or 404.
    Root HTML is also not served in public mode.
    """
    monkeypatch.setenv("HASSIO_TOKEN", "token")
    monkeypatch.setenv("HASSIO_RUN_MODE", "public")
    app, conf = _reload_app_and_config()
    assert conf.HASSIO_TOKEN == "token"
    assert conf.HASSIO_RUN_MODE == "public"
    assert conf.base_path == ""

    client = TestClient(app)

    # /api/log belongs to api_public => should exist
    resp_log = client.post("/api/log")
    # In your code, it may return 401 unless you provide a server_api_key,
    # but it should NOT 404. So we check != 404 to confirm the route is there.
    assert resp_log.status_code != 404, "POST /api/log should be mounted in 'public' mode."

    # /api/frames belongs to api_with_auth => should NOT exist => 404
    resp_frames = client.get("/api/frames")
    assert resp_frames.status_code == 404, "Expected /api/frames to be missing in 'public' mode."

    # Root HTML => not served in public mode => 404
    resp_root = client.get("/")
    assert resp_root.status_code == 404, "Root HTML should not be served in public mode."

@pytest.mark.asyncio
async def test_hassio_run_mode_ingress(clear_env, monkeypatch):
    """
    HASSIO_RUN_MODE=ingress with a HASSIO_TOKEN means that all three routers
    (api_public, api_no_auth, api_with_auth) are mounted behind the base path,
    but none require a token because Home Assistant handles authentication upstream.
    """
    custom_ingress = "/hostname/ingress"
    monkeypatch.setenv("HASSIO_TOKEN", "token")
    monkeypatch.setenv("HASSIO_RUN_MODE", "ingress")
    monkeypatch.setenv("HOSTNAME", "hostname")

    def mock_requests_get(url, headers):
        assert url == "http://supervisor/addons/self/info"
        assert headers["Authorization"] == "Bearer token"
        assert headers["Content-Type"] == "application/json"
        return MockResponse(200, content='{"data": {"ingress_url": "http://hostname/ingress/"}}')


    with patch("app.config.requests.get") as mock_get:
        mock_get.return_value = MockResponse(200, content='{"data": {"ingress_url": "..."}')

        app, conf = _reload_app_and_config()
        assert conf.HASSIO_TOKEN == "token"
        assert conf.HASSIO_RUN_MODE == "ingress"
        assert conf.base_path == custom_ingress

        client = TestClient(app)

        # 1. /my_ingress_path/api/has_first_user => from api_no_auth => no token needed => should be 200
        resp_no_auth = client.get(f"{custom_ingress}/api/has_first_user")
        assert resp_no_auth.status_code == 200, "api_no_auth should be accessible under /my_ingress_path."

        # 2. /my_ingress_path/api/frames => from api_with_auth => but in ingress mode, no token needed => 200
        resp_auth = client.get(f"{custom_ingress}/api/frames")
        assert resp_auth.status_code != 404, "Expected /api/frames to exist under the ingress path."
        # We can check 200 or 401 depending on your logic. Usually it's 200 in ingress mode (no token required).
        assert resp_auth.status_code == 200, "Expected no token required for /api/frames in ingress mode."

        # 3. Root HTML => served at /my_ingress_path => 200
        resp_root = client.get(f"{custom_ingress}")
        assert resp_root.status_code == 200, "HTML root should be served behind the custom ingress path."

        # 4. /api/frames (without the prefix) => 404
        resp_no_prefix = client.get("/api/frames")
        assert resp_no_prefix.status_code == 404, "Everything must be behind base_path in ingress mode."
