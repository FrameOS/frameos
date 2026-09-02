import io
import json
import zipfile

from fastapi import HTTPException

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
async def test_create_template_stamps_scene_execution(async_client, db):
    payload = {
        "name": "Stamped",
        "scenes": [
            {"id": "plain", "nodes": []},
            {"id": "nim", "nodes": [{"id": "n", "type": "source", "data": {}}]},
            {"id": "explicit", "settings": {"execution": "interpreted"}, "nodes": []},
        ],
        "config": {},
    }
    response = await async_client.post("/api/templates", json=payload)
    assert response.status_code == 201
    template = db.get(Template, response.json()["id"])
    # Absent means interpreted, Nim or not; an explicit value is kept.
    assert [scene["settings"]["execution"] for scene in template.scenes] == ["interpreted", "interpreted", "interpreted"]


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


def fake_http_client(routes: dict, chunk_size: int = 64 * 1024, content_length: bool = True):
    """A stand-in for httpx.AsyncClient whose `.stream("GET", url)` serves
    `routes[url]` (bytes, or an iterable of byte chunks for a body that
    keeps coming) the way the template route reads it."""

    class FakeStream:
        def __init__(self, body):
            self.body = body
            self.headers = {}
            if isinstance(body, bytes) and content_length:
                self.headers["content-length"] = str(len(body))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            if isinstance(self.body, bytes):
                for offset in range(0, len(self.body), chunk_size):
                    yield self.body[offset : offset + chunk_size]
            else:
                for chunk in self.body:
                    yield chunk

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def stream(self, method, url, headers=None, **kwargs):
            assert method == "GET"
            if url not in routes:
                raise AssertionError(f"unexpected URL fetched: {url}")
            return FakeStream(routes[url])

    return lambda **kwargs: FakeClient()


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

    import app.api.templates as templates_module

    monkeypatch.setattr(
        templates_module.httpx, "AsyncClient", fake_http_client({page_url: page_html, zip_url: zip_bytes})
    )

    response = await async_client.post("/api/templates", json={"url": page_url})
    assert response.status_code == 201, response.text
    assert response.json()["name"] == "Sunrise"


@pytest.mark.asyncio
async def test_create_template_from_zip_keeps_scene_origin(async_client, db):
    """A zip downloaded from the FrameOS Cloud store carries each scene's
    `origin` (page href, store uuid, version). The import keeps it verbatim:
    it is how the Templates panel later knows where an installed scene came
    from and that a newer version exists."""
    origin = {
        "href": "https://scenes.frameos.net/s/visited-world-map",
        "storeSceneId": "0f3d1c2a-1111-4222-8333-444455556666",
        "version": "4",
        "sceneId": "visited-world-map",
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "Visited World Map/template.json",
            json.dumps({"name": "Visited World Map", "scenes": "./scenes.json"}),
        )
        zf.writestr(
            "Visited World Map/scenes.json",
            json.dumps([{"id": "visited-world-map", "name": "Visited World Map", "nodes": [], "origin": origin}]),
        )

    response = await async_client.post(
        "/api/templates",
        files={"file": ("visited-world-map-v4.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 201, response.text
    template_id = response.json()["id"]

    fetched = await async_client.get(f"/api/templates/{template_id}")
    assert fetched.status_code == 200
    assert fetched.json()["scenes"][0]["origin"] == origin


@pytest.mark.asyncio
async def test_create_template_from_url_rejects_pages_without_meta(async_client, db, monkeypatch):
    import app.api.templates as templates_module

    page_url = "https://example.com/some-page"
    monkeypatch.setattr(
        templates_module.httpx,
        "AsyncClient",
        fake_http_client({page_url: b"<html><head><title>Not a scene</title></head></html>"}),
    )

    response = await async_client.post("/api/templates", json={"url": page_url})
    assert response.status_code == 422
    assert "frameos:zip" in response.json()["detail"]


def template_zip_with(scenes_json: bytes, name: str = "Big") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{name}/template.json", json.dumps({"name": name, "scenes": "./scenes.json"}))
        zf.writestr(f"{name}/scenes.json", scenes_json)
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_create_template_caps_the_fetched_zip(async_client, db, monkeypatch):
    """A pasted URL is streamed and dropped once it passes the zip cap — a
    body that omits Content-Length and just keeps coming never buffers
    unbounded — and a declared oversize is refused before the first byte."""
    import app.api.templates as templates_module
    from app.utils import upload_limits

    monkeypatch.setattr(upload_limits, "MAX_TEMPLATE_ZIP_BYTES", 1024)
    monkeypatch.setattr(templates_module, "MAX_TEMPLATE_ZIP_BYTES", 1024)

    endless = "https://example.com/endless.zip"
    served = []

    def chunks():
        for _ in range(1000):
            served.append(1)
            yield b"x" * 256

    monkeypatch.setattr(
        templates_module.httpx, "AsyncClient", fake_http_client({endless: chunks()}, content_length=False)
    )
    response = await async_client.post("/api/templates", json={"url": endless})
    assert response.status_code == 413, response.text
    assert len(served) <= 6  # stopped right after the cap, not at the end

    declared = "https://example.com/declared.zip"
    monkeypatch.setattr(templates_module.httpx, "AsyncClient", fake_http_client({declared: b"x" * 4096}))
    response = await async_client.post("/api/templates", json={"url": declared})
    assert response.status_code == 413, response.text


@pytest.mark.asyncio
async def test_create_template_caps_zip_members(async_client, db, monkeypatch):
    """scenes.json is inflated in memory: a tiny zip whose scenes.json
    expands past the member cap is refused, whether uploaded or fetched."""
    import app.api.templates as templates_module
    from app.utils import upload_limits

    monkeypatch.setattr(templates_module, "MAX_TEMPLATE_MEMBER_BYTES", 64 * 1024)

    bomb = template_zip_with(b" " * (2 * 1024 * 1024))  # ~2 KB compressed, 2 MB inflated
    assert len(bomb) < 16 * 1024

    response = await async_client.post("/api/templates", files={"file": ("bomb.zip", bomb, "application/zip")})
    assert response.status_code == 413, response.text
    assert "scenes.json" in response.json()["detail"]

    url = "https://example.com/bomb.zip"
    monkeypatch.setattr(templates_module.httpx, "AsyncClient", fake_http_client({url: bomb}))
    response = await async_client.post("/api/templates", json={"url": url})
    assert response.status_code == 413, response.text

    # The same member cap protects the backup restore path.
    with pytest.raises(HTTPException) as excinfo:
        templates_module.parse_template_zip(bomb)
    assert excinfo.value.status_code == 413

    fine = template_zip_with(json.dumps([{"id": "s", "nodes": []}]).encode())
    response = await async_client.post("/api/templates", files={"file": ("fine.zip", fine, "application/zip")})
    assert response.status_code == 201, response.text
    assert response.json()["name"] == "Big"


@pytest.mark.asyncio
async def test_create_template_rejects_non_zip_uploads(async_client, db):
    response = await async_client.post(
        "/api/templates", files={"file": ("notes.zip", b"this is not a zip", "application/zip")}
    )
    assert response.status_code == 422
    assert "zip" in response.json()["detail"].lower()

@pytest.mark.asyncio
async def test_export_template_strips_scene_prompts(async_client, db):
    scenes = [
        {'id': 'a', 'name': 'AI scene', 'nodes': [], 'edges': [], 'settings': {'prompt': 'secret request', 'refreshInterval': 60}},
        {'id': 'b', 'name': 'Plain', 'nodes': [], 'edges': []},
    ]
    t = Template(project_id=async_client.project_id, name='Prompted', scenes=scenes, config={})
    db.add(t)
    db.commit()
    response = await async_client.get(f'/api/templates/{t.id}/export')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
        exported = json.loads(zf.read('Prompted/scenes.json'))
    assert exported[0]['settings'] == {'refreshInterval': 60}
    assert 'settings' not in exported[1]
    # The stored template is untouched.
    db.refresh(t)
    assert t.scenes[0]['settings']['prompt'] == 'secret request'
