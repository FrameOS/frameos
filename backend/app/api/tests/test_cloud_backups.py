"""Cloud config backups (Phase 3): push, restore, sanitization, tarball export."""
import base64
import io
import json
import tarfile

import pytest

from app.models.cloud import CloudBackendLink
from app.models.frame import Frame
from app.models.template import Template
from app.utils import cloud_backup, cloud_link

PROVIDER = "https://cloud.frameos.net"

BACKUP_SCOPES = "backend:link backend:read backup:templates backup:frames"


def make_connected_link(db, scope=BACKUP_SCOPES):
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


def make_frame(db, project_id):
    frame = Frame(
        project_id=project_id,
        name="Kitchen frame",
        frame_host="10.0.0.5",
        ssh_user="pi",
        ssh_pass="super-secret-pass",
        ssh_keys={"private": "PRIVATE KEY"},
        frame_access_key="frame-access-key-1",
        server_api_key="server-api-key-1",
        status="ready",
        scenes=[{"id": "scene-1", "nodes": []}],
        network={"wifiSSID": "HomeWifi", "wifiPassword": "wifi-secret"},
        agent={"agentEnabled": True, "agentSharedSecret": "agent-secret"},
        https_proxy={"enable": True, "certs": {"server_key": "TLS KEY"}},
        terminal_history=["ssh something"],
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


def make_template(db, project_id):
    template = Template(
        project_id=project_id,
        name="My template",
        description="desc",
        scenes=[{"id": "scene-1", "nodes": []}],
        config={},
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template


@pytest.fixture
def backup_calls(monkeypatch):
    calls = {"save": [], "list": [], "get": [], "delete": []}
    responses = {
        "save": (200, {"status": "saved", "backup": {"id": "b-1"}}),
        "list": (200, {"backups": []}),
        "get": (200, {"backup": {}}),
        "delete": (200, {"status": "deleted"}),
    }

    def make(name):
        async def call(*args):
            calls[name].append(args)
            return responses[name]

        return call

    monkeypatch.setattr(cloud_link, "backup_save", make("save"))
    monkeypatch.setattr(cloud_link, "backup_list", make("list"))
    monkeypatch.setattr(cloud_link, "backup_get", make("get"))
    monkeypatch.setattr(cloud_link, "backup_delete", make("delete"))
    return calls, responses


def test_sanitize_frame_dict_strips_all_secrets(db):
    frame_dict = {
        "id": 7,
        "name": "Kitchen",
        "ssh_pass": "x",
        "ssh_keys": {"private": "KEY"},
        "frame_access_key": "x",
        "server_api_key": "x",
        "frame_admin_auth": {"user": "a", "pass": "b"},
        "https_proxy": {"certs": {"server_key": "TLS"}},
        "last_successful_deploy": {"ssh_pass": "x"},
        "terminal_history": ["secrets typed here"],
        "network": {"wifiSSID": "Home", "wifiPassword": "hunter2", "wifiHotspotPassword": "x"},
        "agent": {"agentEnabled": True, "agentSharedSecret": "x"},
        "scenes": [{"id": "s"}],
    }
    clean = cloud_backup.sanitize_frame_dict(frame_dict)
    dumped = json.dumps(clean)
    for secret in ("hunter2", "KEY", "TLS", "ssh_pass", "agentSharedSecret", "terminal_history"):
        assert secret not in dumped
    assert clean["network"]["wifiSSID"] == "Home"
    assert clean["agent"]["agentEnabled"] is True
    assert clean["scenes"] == [{"id": "s"}]


@pytest.mark.asyncio
async def test_backup_frame_pushes_sanitized_payload(async_client, db, backup_calls):
    calls, _ = backup_calls
    make_connected_link(db)
    frame = make_frame(db, async_client.project_id)

    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 200, response.text

    provider_url, token, payload = calls["save"][0]
    assert payload["kind"] == "frames"
    assert payload["item_key"] == f"frame-{frame.id}"
    content = json.loads(base64.b64decode(payload["content_base64"]))
    assert content["format"] == "frameos-frame-backup-v1"
    assert content["frame"]["name"] == "Kitchen frame"
    dumped = json.dumps(content)
    for secret in ("super-secret-pass", "wifi-secret", "agent-secret", "PRIVATE KEY", "TLS KEY", "frame-access-key-1", "server-api-key-1"):
        assert secret not in dumped


@pytest.mark.asyncio
async def test_backup_requires_scope(async_client, db, backup_calls):
    make_connected_link(db, scope="backend:link backend:read")
    frame = make_frame(db, async_client.project_id)

    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 403

    listing = await async_client.get("/api/cloud/backups")
    assert listing.status_code == 200
    assert listing.json()["missing_scope"] is True


@pytest.mark.asyncio
async def test_backup_requires_link(async_client, db, backup_calls):
    frame = make_frame(db, async_client.project_id)
    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_backup_template_and_list(async_client, db, backup_calls):
    calls, responses = backup_calls
    make_connected_link(db)
    template = make_template(db, async_client.project_id)

    response = await async_client.post(
        "/api/cloud/backups/templates", json={"template_id": str(template.id)}
    )
    assert response.status_code == 200, response.text
    _, _, payload = calls["save"][0]
    assert payload["kind"] == "templates"
    assert payload["item_key"] == f"template-{template.id}"
    assert payload["content_type"] == "application/zip"

    responses["list"] = (
        200,
        {"backups": [{"id": "b-1", "kind": "templates", "item_key": payload["item_key"]}]},
    )
    listing = await async_client.get("/api/cloud/backups")
    assert listing.status_code == 200
    assert listing.json()["backups"][0]["id"] == "b-1"


@pytest.mark.asyncio
async def test_restore_template_backup(async_client, db, backup_calls):
    from app.api.templates import template_zip_bytes

    calls, responses = backup_calls
    make_connected_link(db)
    template = make_template(db, async_client.project_id)
    zip_bytes = template_zip_bytes(template)
    db.delete(template)
    db.commit()

    responses["get"] = (
        200,
        {
            "backup": {
                "id": "b-1",
                "kind": "templates",
                "name": "My template",
                "content_base64": base64.b64encode(zip_bytes).decode(),
            }
        },
    )
    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": "b-1", "project_id": async_client.project_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "template"

    restored = db.query(Template).first()
    assert restored is not None
    assert restored.name == "My template"
    assert restored.scenes == [{"id": "scene-1", "nodes": []}]


@pytest.mark.asyncio
async def test_restore_frame_backup(async_client, db, backup_calls):
    calls, responses = backup_calls
    make_connected_link(db)
    frame = make_frame(db, async_client.project_id)
    payload = cloud_backup.frame_backup_payload(frame.to_dict(), "Default Project")
    db.delete(frame)
    db.commit()

    responses["get"] = (
        200,
        {
            "backup": {
                "id": "b-2",
                "kind": "frames",
                "name": "Kitchen frame",
                "content_base64": base64.b64encode(json.dumps(payload).encode()).decode(),
            }
        },
    )
    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": "b-2", "project_id": async_client.project_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "frame"

    restored = db.query(Frame).first()
    assert restored is not None
    assert restored.name == "Kitchen frame"
    assert restored.status == "uninitialized"
    assert restored.scenes == [{"id": "scene-1", "nodes": []}]
    # Secrets were never in the backup; fresh ones are generated locally.
    assert restored.ssh_pass is None
    assert restored.frame_access_key
    assert restored.frame_access_key != "frame-access-key-1"
    assert restored.network.get("wifiSSID") == "HomeWifi"
    assert "wifiPassword" not in (restored.network or {})


@pytest.mark.asyncio
async def test_export_tarball(async_client, db):
    frame = make_frame(db, async_client.project_id)
    template = make_template(db, async_client.project_id)

    response = await async_client.get("/api/backup/export")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/gzip"

    with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as tar:
        names = tar.getnames()
        assert "manifest.json" in names
        frame_path = f"projects/{async_client.project_id}/frames/frame-{frame.id}.json"
        assert frame_path in names
        assert any(name.startswith(f"projects/{async_client.project_id}/templates/") for name in names)

        manifest = json.loads(tar.extractfile("manifest.json").read())
        assert manifest["format"] == "frameos-backup-v1"
        assert manifest["projects"][0]["frames"] == 1
        assert manifest["projects"][0]["templates"] == 1

        # The local tarball keeps full fidelity, credentials included.
        frame_json = json.loads(tar.extractfile(frame_path).read())
        assert frame_json["ssh_pass"] == "super-secret-pass"


@pytest.mark.asyncio
async def test_export_requires_login(db):
    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport
    from app.fastapi import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/backup/export")
    assert response.status_code == 401
