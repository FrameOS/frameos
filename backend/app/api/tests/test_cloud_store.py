"""Store publishing (STORE-TODO Phase 2): publish templates to the cloud store."""
import base64
import io
import json
import zipfile

import pytest

from app.models.cloud import CloudBackendLink
from app.models.template import Template
from app.utils import cloud_link

PROVIDER = "https://cloud.frameos.net"

STORE_SCOPES = "backend:link backend:read store:publish"


def make_connected_link(db, scope=STORE_SCOPES):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        scope=scope,
        local_origin="http://test",
        cloud_account_id="acc-1",
    )
    db.add(link)
    db.commit()
    return link


def make_template(db, project_id):
    template = Template(
        project_id=project_id,
        name="Sunrise Clock",
        description="A calm sunrise clock",
        scenes=[{"id": "scene-1", "nodes": []}],
        config={},
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template


@pytest.fixture
def store_calls(monkeypatch):
    calls = []
    response = {
        "status": "published",
        "scene": {
            "id": "scene-uuid",
            "slug": "sunrise-clock",
            "url": f"{PROVIDER}/scenes/sunrise-clock",
            "version": 1,
            "visibility": "private",
        },
    }

    async def store_publish(*args):
        calls.append(args)
        return 200, response

    monkeypatch.setattr(cloud_link, "store_publish", store_publish)
    return calls


@pytest.mark.asyncio
async def test_publish_sends_template_zip(async_client, db, store_calls):
    make_connected_link(db)
    template = make_template(db, async_client.project_id)

    response = await async_client.post("/api/cloud/store/publish", json={"template_id": str(template.id)})
    assert response.status_code == 200, response.text
    assert response.json()["scene"]["slug"] == "sunrise-clock"

    provider_url, token, payload = store_calls[0]
    assert provider_url == PROVIDER
    assert payload["name"] == "Sunrise Clock"
    assert payload["description"] == "A calm sunrise clock"
    assert payload["content_type"] == "application/zip"
    assert "visibility" not in payload

    # The payload is the standard template interchange zip.
    zip_bytes = base64.b64decode(payload["content_base64"])
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        names = archive.namelist()
        manifest_path = next(name for name in names if name.endswith("template.json"))
        scenes_path = next(name for name in names if name.endswith("scenes.json"))
        manifest = json.loads(archive.read(manifest_path))
        scenes = json.loads(archive.read(scenes_path))
    assert manifest["name"] == "Sunrise Clock"
    assert scenes == [{"id": "scene-1", "nodes": []}]


@pytest.mark.asyncio
async def test_publish_passes_explicit_visibility(async_client, db, store_calls):
    make_connected_link(db)
    template = make_template(db, async_client.project_id)

    response = await async_client.post(
        "/api/cloud/store/publish", json={"template_id": str(template.id), "visibility": "public"}
    )
    assert response.status_code == 200
    assert store_calls[0][2]["visibility"] == "public"


@pytest.mark.asyncio
async def test_publish_requires_scope(async_client, db, store_calls):
    make_connected_link(db, scope="backend:link backend:read")
    template = make_template(db, async_client.project_id)

    response = await async_client.post("/api/cloud/store/publish", json={"template_id": str(template.id)})
    assert response.status_code == 403
    assert store_calls == []


@pytest.mark.asyncio
async def test_publish_requires_link(async_client, db, store_calls):
    template = make_template(db, async_client.project_id)
    response = await async_client.post("/api/cloud/store/publish", json={"template_id": str(template.id)})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_publish_unknown_template_404s(async_client, db, store_calls):
    make_connected_link(db)
    response = await async_client.post(
        "/api/cloud/store/publish", json={"template_id": "00000000-0000-0000-0000-000000000000"}
    )
    assert response.status_code == 404
