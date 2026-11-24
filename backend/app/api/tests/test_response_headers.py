"""Headers every answer carries (app/utils/response_headers.py)."""
import pytest

from app import config as app_config
from app.models.cloud import CloudBackendLink
from app.utils import response_headers


@pytest.fixture(autouse=True)
def fresh_ancestors():
    response_headers.forget_frame_ancestors()
    yield
    response_headers.forget_frame_ancestors()


@pytest.mark.asyncio
async def test_every_answer_says_nosniff(no_auth_client, async_client):
    for response in (
        await no_auth_client.get("/api/has_first_user"),
        await no_auth_client.get("/api/frames"),
        await async_client.get("/api/user"),
    ):
        assert response.headers["x-content-type-options"] == "nosniff", response.request.url


@pytest.mark.asyncio
async def test_the_app_may_be_framed_by_itself_and_its_cloud_only(no_auth_client, db, monkeypatch):
    monkeypatch.setattr(app_config.config, "FRAMEOS_CLOUD_URL", "https://cloud.example.com")
    response = await no_auth_client.get("/")
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["content-security-policy"] == "frame-ancestors 'self' https://cloud.example.com"

    # A linked provider of its own is added; JSON carries no frame rule.
    db.add(CloudBackendLink(provider_url="https://frames.example.org/", status="connected"))
    db.commit()
    response_headers.forget_frame_ancestors()
    response = await no_auth_client.get("/")
    assert response.headers["content-security-policy"] == (
        "frame-ancestors 'self' https://cloud.example.com https://frames.example.org"
    )
    assert "content-security-policy" not in (await no_auth_client.get("/api/has_first_user")).headers


def test_home_assistant_ingress_frames_the_app_from_its_own_address(monkeypatch):
    """Under ingress Home Assistant's page frames the app: no frame rule."""
    import asyncio

    monkeypatch.setattr(app_config.config, "HASSIO_RUN_MODE", "ingress")
    sent: list[dict] = []

    async def html_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/html")]})
        await send({"type": "http.response.body", "body": b"<html></html>"})

    async def run():
        async def receive():
            return {"type": "http.request", "body": b""}

        async def send(message):
            sent.append(message)

        await response_headers.ResponseHeadersMiddleware(html_app)({"type": "http", "method": "GET", "path": "/", "headers": []}, receive, send)

    asyncio.run(run())
    headers = dict(sent[0]["headers"])
    assert headers[b"x-content-type-options"] == b"nosniff"
    assert b"content-security-policy" not in headers
