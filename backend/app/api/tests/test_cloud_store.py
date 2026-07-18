"""Store publishing (STORE-TODO Phase 2): publish templates to the cloud store."""
import base64
import io
import json
import zipfile

import pytest

from app.models.cloud import CloudBackendLink
from app.models.template import Template
from app.utils import cloud_link
from app.utils.versions import current_frameos_version

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
    # Zips are stamped with the FrameOS version they were exported with; the
    # store surfaces it on scene listings.
    assert manifest["frameosVersion"] == current_frameos_version()
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


def make_frame(db, project_id):
    from app.models.frame import Frame

    frame = Frame(
        project_id=project_id,
        name="Kitchen frame",
        frame_host="10.0.0.5",
        ssh_user="pi",
        status="ready",
        scenes=[{"id": "scene-1", "nodes": []}, {"id": "scene-2", "nodes": []}],
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


@pytest.mark.asyncio
async def test_publish_inline_scenes_from_frame(async_client, db, store_calls):
    make_connected_link(db)
    frame = make_frame(db, async_client.project_id)

    response = await async_client.post(
        "/api/cloud/store/publish",
        json={
            "name": "Straight off the frame",
            "description": "One scene",
            "scenes": [{"id": "scene-2", "nodes": []}],
            "from_frame_id": frame.id,
            "image_scene_id": "scene-2",
        },
    )
    assert response.status_code == 200, response.text

    payload = store_calls[0][2]
    assert payload["name"] == "Straight off the frame"
    zip_bytes = base64.b64decode(payload["content_base64"])
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        scenes_path = next(name for name in archive.namelist() if name.endswith("scenes.json"))
        scenes = json.loads(archive.read(scenes_path))
    assert scenes == [{"id": "scene-2", "nodes": []}]
    # Nothing is persisted locally: publishing to the cloud drive is not "save to my scenes".
    from app.models.template import Template as TemplateModel

    assert db.query(TemplateModel).filter_by(name="Straight off the frame").count() == 0


@pytest.mark.asyncio
async def test_publish_inline_requires_name_and_scenes(async_client, db, store_calls):
    make_connected_link(db)
    response = await async_client.post("/api/cloud/store/publish", json={"name": "No scenes"})
    assert response.status_code == 422
    assert store_calls == []


@pytest.mark.asyncio
async def test_publish_inline_unknown_frame_404s(async_client, db, store_calls):
    make_connected_link(db)
    response = await async_client.post(
        "/api/cloud/store/publish",
        json={"name": "X", "scenes": [{"id": "s", "nodes": []}], "from_frame_id": 424242},
    )
    assert response.status_code == 404
    assert store_calls == []


@pytest.mark.asyncio
async def test_drive_lists_scenes_and_proxies_images(async_client, db, monkeypatch):
    make_connected_link(db)

    async def store_drive(provider_url, access_token):
        assert provider_url == PROVIDER
        assert access_token == "link-token-secret"
        return 200, {
            "name": "My cloud drive",
            "templates": [
                {
                    "id": "sunrise-clock",
                    "name": "Sunrise Clock",
                    "sceneId": "11111111-1111-1111-1111-111111111111",
                    "image": f"{PROVIDER}/api/store/scenes/11111111-1111-1111-1111-111111111111/image",
                    "zip": f"{PROVIDER}/api/store/scenes/11111111-1111-1111-1111-111111111111/download",
                    "visibility": "private",
                }
            ],
        }

    monkeypatch.setattr(cloud_link, "store_drive", store_drive)
    response = await async_client.get("/api/cloud/store/drive")
    assert response.status_code == 200, response.text
    template = response.json()["templates"][0]
    # Image URLs are rewritten to the authenticated backend proxy; zips keep
    # their provider URL (POST /api/templates attaches the token for those).
    assert template["image"] == "/api/cloud/store/drive/image/11111111-1111-1111-1111-111111111111"
    assert template["zip"].startswith(PROVIDER)


@pytest.mark.asyncio
async def test_drive_requires_store_scope(async_client, db):
    make_connected_link(db, scope="backend:link backend:read")
    response = await async_client.get("/api/cloud/store/drive")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_drive_image_proxy(async_client, db, monkeypatch):
    make_connected_link(db)

    async def cloud_get_binary(provider_url, path, access_token):
        assert path == "/api/store/scenes/abc/image"
        assert access_token == "link-token-secret"
        return 200, "image/jpeg", b"jpeg-bytes"

    monkeypatch.setattr(cloud_link, "cloud_get_binary", cloud_get_binary)
    response = await async_client.get("/api/cloud/store/drive/image/abc")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content == b"jpeg-bytes"


def test_cloud_headers_only_for_provider_urls(db):
    from app.utils.cloud_backup import cloud_headers_for_url

    make_connected_link(db)
    assert cloud_headers_for_url(db, f"{PROVIDER}/api/store/scenes/x/download") == {
        "authorization": "Bearer link-token-secret"
    }
    assert cloud_headers_for_url(db, "https://evil.example.com/api/store/scenes/x/download") == {}
    assert cloud_headers_for_url(db, f"{PROVIDER}.evil.example.com/zip") == {}
    assert cloud_headers_for_url(db, None) == {}
