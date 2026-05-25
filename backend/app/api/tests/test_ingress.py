import pytest
import importlib
import os
from starlette.testclient import TestClient
from unittest.mock import patch

from app.conftest import MockResponse

HASSIO_ENV_KEYS = ("HASSIO_RUN_MODE", "HASSIO_TOKEN", "SUPERVISOR_TOKEN")


@pytest.fixture
def clear_env():
    """
    A helper fixture to remove/clear environment variables before each test
    so each test starts from a known baseline.
    """
    original_env = {key: os.environ.get(key) for key in HASSIO_ENV_KEYS}
    for key in HASSIO_ENV_KEYS:
        os.environ.pop(key, None)
    _reload_app_and_config()
    yield
    for key, value in original_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    _reload_app_and_config()

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
      - /api/frames => requires auth
      - /api/has_first_user => no auth needed
      - / => root HTML served
    """
    app, conf = _reload_app_and_config()
    assert conf.HASSIO_TOKEN is None
    assert conf.HASSIO_RUN_MODE is None
    assert conf.ingress_path == ""

    client = TestClient(app)

    # /api/has_first_user => belongs to api_no_auth => no token => 200 OK
    resp_no_auth = client.get("/api/has_first_user")
    assert resp_no_auth.status_code == 200

    # /api/frames => belongs to api_with_auth => must have token => 401
    resp_auth_needed = client.get("/api/frames")
    assert resp_auth_needed.status_code == 401

    # Root => 200
    resp_root = client.get("/")
    assert resp_root.status_code == 200


@pytest.mark.asyncio
async def test_hassio_run_mode_public(clear_env, monkeypatch):
    """
    HASSIO_RUN_MODE=public => only api_public is mounted.
    /api/frames => should be 404
    /api/log => route exists, but might 401 if missing API key, etc. => definitely not 404
    / => not served => 404
    """
    monkeypatch.setenv("HASSIO_TOKEN", "token")
    monkeypatch.setenv("HASSIO_RUN_MODE", "public")
    app, conf = _reload_app_and_config()
    assert conf.HASSIO_TOKEN == "token"
    assert conf.HASSIO_RUN_MODE == "public"
    assert conf.ingress_path == ""

    client = TestClient(app)

    # /api/log => from api_public => not 404
    resp_log = client.post("/api/log")
    assert resp_log.status_code != 404, "POST /api/log should be mounted in 'public' mode."

    # /api/frames => from api_with_auth => 404
    resp_frames = client.get("/api/frames")
    assert resp_frames.status_code == 404

    # Root => 404
    resp_root = client.get("/")
    assert resp_root.status_code == 404


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
    monkeypatch.setenv("SUPERVISOR_TOKEN", "token")

    def mock_requests_get(url, headers):
        assert url == "http://supervisor/addons/self/info"
        assert headers["Authorization"] == "Bearer token"
        assert headers["Content-Type"] == "application/json"
        return MockResponse(200, content='{"data": {"ingress_url": "/hostname/ingress/"}}')

    with patch("app.config.requests.get", side_effect=mock_requests_get):
        app, conf = _reload_app_and_config()

    assert conf.HASSIO_TOKEN == "token"
    assert conf.HASSIO_RUN_MODE == "ingress"
    assert conf.ingress_path == custom_ingress, f"Expected conf.ingress_path={custom_ingress}, got '{conf.ingress_path}'"

    client = TestClient(app)

    resp_no_auth = client.get("/api/has_first_user")
    assert resp_no_auth.status_code == 200

    resp_frames = client.get("/api/frames")
    assert resp_frames.status_code == 200

    resp_user = client.get("/api/user")
    assert resp_user.status_code == 401
    assert resp_user.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."

    resp_email = client.post("/api/user/email", json={"email": "new@example.com"})
    assert resp_email.status_code == 401
    assert resp_email.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."

    resp_password = client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )
    assert resp_password.status_code == 401
    assert resp_password.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."

    resp_root = client.get("/")
    assert resp_root.status_code == 200
