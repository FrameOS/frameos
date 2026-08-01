import pytest
from app.models.template import Template


@pytest.mark.asyncio
async def test_create_template(async_client, db):
    payload = {
        "name": "New Template",
        "description": "A test template",
        "scenes": [],
        "config": {},
    }
    # Post JSON (the same style as your fetch call):
    response = await async_client.post(
        "/api/templates",
        json=payload,
    )
    # Should return 201 on create
    assert response.status_code == 201
    data = response.json()
    assert isinstance(data, dict)
    assert data.get('name') == 'New Template'


@pytest.mark.asyncio
async def test_get_templates(async_client, db):
    # Insert a couple
    t1 = Template(project_id=async_client.project_id, name="Template1")
    t2 = Template(project_id=async_client.project_id, name="Template2")
    db.add_all([t1, t2])
    db.commit()

    response = await async_client.get('/api/templates')
    assert response.status_code == 200
    templates = response.json()
    assert isinstance(templates, list)
    assert len(templates) >= 2  # We added at least 2


@pytest.mark.asyncio
async def test_get_nonexistent_template(async_client):
    response = await async_client.get('/api/templates/999999')
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_export_template(async_client, db):
    t = Template(project_id=async_client.project_id, name="Exportable", scenes=[], config={})
    db.add(t)
    db.commit()

    response = await async_client.get(f'/api/templates/{t.id}/export')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/zip'


@pytest.mark.asyncio
async def test_delete_nonexistent_template(async_client):
    response = await async_client.delete('/api/templates/999999')
    assert response.status_code == 404
    assert "Template not found" in response.json()['detail']


def test_frameos_zip_url_from_html():
    from app.api.templates import frameos_zip_url_from_html

    page = "https://cloud.example.com/scenes/sunrise"
    # name before content, relative URL resolved against the page.
    html = b'<html><head><meta name="frameos:zip" content="/api/store/scenes/abc/download"/></head></html>'
    assert (
        frameos_zip_url_from_html(html, page)
        == "https://cloud.example.com/api/store/scenes/abc/download"
    )
    # content before name, absolute URL, escaped ampersand.
    html = b'<meta content="https://x.example.com/y.zip?a=1&amp;b=2" name=\'frameos:zip\'>'
    assert frameos_zip_url_from_html(html, page) == "https://x.example.com/y.zip?a=1&b=2"
    assert frameos_zip_url_from_html(b"<html><head></head></html>", page) is None


@pytest.mark.asyncio
async def test_create_template_from_scene_page_url(async_client, db, monkeypatch):
    """Pasting a scene page URL (not a zip) installs through the page's
    frameos:zip meta tag — the flow behind 'copy this link into the
    Templates search box' on FrameOS Cloud scene pages."""
    import io
    import json as jsonlib
    import zipfile as zipfile_lib

    buffer = io.BytesIO()
    with zipfile_lib.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "Sunrise/template.json",
            jsonlib.dumps({"name": "Sunrise", "scenes": "./scenes.json"}),
        )
        zf.writestr("Sunrise/scenes.json", jsonlib.dumps([{"id": "scene-1", "nodes": []}]))
    zip_bytes = buffer.getvalue()

    page_url = "https://cloud.example.com/scenes/sunrise"
    zip_url = "https://cloud.example.com/api/store/scenes/abc/download"
    page_html = (
        b'<html><head><meta name="frameos:zip" '
        b'content="/api/store/scenes/abc/download"/></head><body>Sunrise</body></html>'
    )

    class FakeResponse:
        def __init__(self, content):
            self.content = content

        def raise_for_status(self):
            return None

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None):
            if url == page_url:
                return FakeResponse(page_html)
            if url == zip_url:
                return FakeResponse(zip_bytes)
            raise AssertionError(f"unexpected URL fetched: {url}")

    import app.api.templates as templates_module

    monkeypatch.setattr(templates_module.httpx, "AsyncClient", lambda **kwargs: FakeClient())

    response = await async_client.post("/api/templates", json={"url": page_url})
    assert response.status_code == 201, response.text
    assert response.json()["name"] == "Sunrise"


@pytest.mark.asyncio
async def test_create_template_from_url_rejects_pages_without_meta(async_client, db, monkeypatch):
    class FakeResponse:
        content = b"<html><head><title>Not a scene</title></head></html>"

        def raise_for_status(self):
            return None

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None):
            return FakeResponse()

    import app.api.templates as templates_module

    monkeypatch.setattr(templates_module.httpx, "AsyncClient", lambda **kwargs: FakeClient())

    response = await async_client.post(
        "/api/templates", json={"url": "https://example.com/some-page"}
    )
    assert response.status_code == 422
    assert "frameos:zip" in response.json()["detail"]
