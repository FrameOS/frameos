"""Cloud config backups (Phase 3): push, restore, encryption, tarball export."""
import base64
import io
import json
import tarfile

import pytest

from app.models.cloud import CloudBackendLink
from app.models.frame import Frame
from app.models.template import Template
from app.utils import backup_crypto, cloud_backup, cloud_link

PROVIDER = "https://cloud.frameos.net"

BACKUP_SCOPES = "backend:link backend:read backup:scenes backup:frames"


def make_connected_link(db, scope=BACKUP_SCOPES, backups_enabled=True, backup_key=None):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        scope=scope,
        local_origin="http://test",
        cloud_account_id="acc-1",
        backup_scenes_enabled=backups_enabled,
        backup_frames_enabled=backups_enabled,
    )
    if backup_key is not None:
        cloud_backup.set_link_backup_key(link, backup_key)
    db.add(link)
    db.commit()
    return link


def link_private_key(db, link):
    db.refresh(link)
    return cloud_backup.link_backup_private_key(link)


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


# ---- crypto -------------------------------------------------------------------


def test_backup_crypto_round_trip():
    private_key = backup_crypto.generate_backup_private_key()
    sealed = backup_crypto.seal(backup_crypto.backup_public_key(private_key), b"hello frames")
    assert backup_crypto.unseal(private_key, sealed) == b"hello frames"

    other_key = backup_crypto.generate_backup_private_key()
    with pytest.raises(ValueError):
        backup_crypto.unseal(other_key, sealed)
    with pytest.raises(ValueError):
        backup_crypto.unseal(private_key, b"not an envelope")


def test_recovery_code_round_trip():
    private_key = backup_crypto.generate_backup_private_key()
    code = backup_crypto.encode_recovery_code(private_key)
    assert code.startswith("FRBK1-")
    assert backup_crypto.decode_recovery_code(code) == private_key
    # Tolerant of case and spacing — people paste from password managers.
    assert backup_crypto.decode_recovery_code(code.lower().replace("-", " ")) == private_key
    for bad in ("", "FRBK1-SHORT", "NOPE1-AAAA", code[:-4] + "!!!!"):
        with pytest.raises(ValueError):
            backup_crypto.decode_recovery_code(bad)


def test_sanitize_frame_dict_strips_machine_secrets_keeps_user_secrets(db):
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
        "network": {"wifiSSID": "Home", "wifiPassword": "hunter2"},
        "agent": {"agentEnabled": True, "agentSharedSecret": "agent-x"},
        "mountpoints": {"items": [{"source": "//nas/photos", "username": "nas", "password": "nas-pass"}]},
        "device_config": {
            "uploadHeaders": [{"name": "Authorization", "value": "Bearer upload-api-key"}],
        },
        "scenes": [
            {
                "id": "s",
                "apiKey": "scene-api-key",
                "fields": [{"name": "apiKey", "secret": True, "value": "field-api-key"}],
            }
        ],
    }
    clean = cloud_backup.sanitize_frame_dict(frame_dict)
    dumped = json.dumps(clean)
    # Per-install machine credentials never leave, even encrypted.
    for secret in ("ssh_pass", "KEY", "TLS", "frame_admin_auth", "terminal_history", "agent-x"):
        assert secret not in dumped
    # User-level secrets are kept — the payload is sealed before upload.
    assert clean["network"] == {"wifiSSID": "Home", "wifiPassword": "hunter2"}
    assert clean["mountpoints"]["items"][0]["password"] == "nas-pass"
    assert clean["agent"] == {"agentEnabled": True}
    assert clean["device_config"]["uploadHeaders"] == [
        {"name": "Authorization", "value": "Bearer upload-api-key"}
    ]
    # Scenes round-trip untouched, including `secret: true` field markers.
    assert clean["scenes"] == frame_dict["scenes"]


@pytest.mark.asyncio
async def test_backup_frame_pushes_encrypted_payload(async_client, db, backup_calls):
    calls, _ = backup_calls
    link = make_connected_link(db)
    frame = make_frame(db, async_client.project_id)

    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 200, response.text

    provider_url, token, payload = calls["save"][0]
    assert payload["kind"] == "frames"
    assert payload["item_key"] == f"frame-{frame.id}"
    content = base64.b64decode(payload["content_base64"])
    envelope = json.loads(content)
    assert envelope["format"] == "frameos-encrypted-backup-v1"
    # The manifest tells you what you would restore, never the config.
    assert envelope["meta"]["name"] == "Kitchen frame"
    # Nothing readable leaves the install: neither machine nor user secrets.
    dumped = content.decode()
    for secret in (
        "super-secret-pass", "wifi-secret", "agent-secret", "PRIVATE KEY", "TLS KEY",
        "frame-access-key-1", "server-api-key-1", "HomeWifi",
    ):
        assert secret not in dumped

    # The key was generated on first use; it decrypts to the full payload,
    # wifi password included, machine credentials still stripped.
    private_key = link_private_key(db, link)
    assert envelope["key_fingerprint"] == backup_crypto.backup_key_fingerprint(private_key)
    inner = json.loads(cloud_backup.decrypt_backup_content(private_key, envelope))
    assert inner["format"] == "frameos-frame-backup-v1"
    assert inner["frame"]["network"]["wifiPassword"] == "wifi-secret"
    assert "ssh_pass" not in inner["frame"]
    assert "agentSharedSecret" not in inner["frame"]["agent"]


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
async def test_backup_requires_local_switch(async_client, db, backup_calls):
    """The scope is a permission; nothing uploads until the feature is on."""
    calls, _ = backup_calls
    make_connected_link(db, backups_enabled=False)
    frame = make_frame(db, async_client.project_id)
    template = make_template(db, async_client.project_id)

    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 403
    response = await async_client.post(
        "/api/cloud/backups/templates", json={"template_id": str(template.id)}
    )
    assert response.status_code == 403
    assert calls["save"] == []

    response = await async_client.post("/api/cloud/backup-features", json={"scenes": True})
    assert response.status_code == 200
    data = response.json()
    assert data["backup_scenes_enabled"] is True
    assert data["backup_frames_enabled"] is False

    response = await async_client.post(
        "/api/cloud/backups/templates", json={"template_id": str(template.id)}
    )
    assert response.status_code == 200, response.text
    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_backup_template_and_list(async_client, db, backup_calls):
    calls, responses = backup_calls
    link = make_connected_link(db)
    template = make_template(db, async_client.project_id)

    response = await async_client.post(
        "/api/cloud/backups/templates", json={"template_id": str(template.id)}
    )
    assert response.status_code == 200, response.text
    _, _, payload = calls["save"][0]
    assert payload["kind"] == "templates"
    assert payload["item_key"] == f"template-{template.id}"
    assert payload["content_type"] == "application/json"
    envelope = json.loads(base64.b64decode(payload["content_base64"]))
    assert envelope["format"] == "frameos-encrypted-backup-v1"
    # The sealed inner payload is the plain template interchange zip.
    private_key = link_private_key(db, link)
    inner = cloud_backup.decrypt_backup_content(private_key, envelope)
    assert inner[:2] == b"PK"

    responses["list"] = (
        200,
        {"backups": [{"id": "b-1", "kind": "templates", "item_key": payload["item_key"]}]},
    )
    listing = await async_client.get("/api/cloud/backups")
    assert listing.status_code == 200
    assert listing.json()["backups"][0]["id"] == "b-1"


def encrypted_backup_response(backup_id, kind, name, private_key, inner_bytes, meta=None):
    content = cloud_backup.encrypted_backup_content(private_key, inner_bytes, meta or {"name": name})
    return (
        200,
        {
            "backup": {
                "id": backup_id,
                "kind": kind,
                "name": name,
                "content_base64": base64.b64encode(content).decode(),
            }
        },
    )


@pytest.mark.asyncio
async def test_restore_template_backup(async_client, db, backup_calls):
    from app.api.templates import template_zip_bytes

    calls, responses = backup_calls
    private_key = backup_crypto.generate_backup_private_key()
    make_connected_link(db, backup_key=private_key)
    template = make_template(db, async_client.project_id)
    zip_bytes = template_zip_bytes(template)
    db.delete(template)
    db.commit()

    responses["get"] = encrypted_backup_response("b-1", "templates", "My template", private_key, zip_bytes)
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
    private_key = backup_crypto.generate_backup_private_key()
    make_connected_link(db, backup_key=private_key)
    frame = make_frame(db, async_client.project_id)
    payload = cloud_backup.frame_backup_payload(frame.to_dict(), "Default Project")
    db.delete(frame)
    db.commit()

    responses["get"] = encrypted_backup_response(
        "b-2", "frames", "Kitchen frame", private_key, json.dumps(payload).encode()
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
    # Machine secrets were never in the backup; fresh ones are generated.
    assert restored.ssh_pass is None
    assert restored.frame_access_key
    assert restored.frame_access_key != "frame-access-key-1"
    assert restored.server_api_key
    assert restored.server_api_key != "server-api-key-1"
    assert restored.agent["agentEnabled"] is True
    assert restored.agent["agentSharedSecret"]
    assert restored.agent["agentSharedSecret"] != "agent-secret"
    # User secrets survive the encrypted round trip.
    assert restored.network == {"wifiSSID": "HomeWifi", "wifiPassword": "wifi-secret"}


@pytest.mark.asyncio
async def test_restore_legacy_plaintext_backup(async_client, db, backup_calls):
    """Backups pushed before encryption shipped still restore."""
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
                "id": "b-3",
                "kind": "frames",
                "name": "Kitchen frame",
                "content_base64": base64.b64encode(json.dumps(payload).encode()).decode(),
            }
        },
    )
    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": "b-3", "project_id": async_client.project_id},
    )
    assert response.status_code == 200, response.text
    assert db.query(Frame).first().name == "Kitchen frame"


@pytest.mark.asyncio
async def test_restore_with_wrong_or_missing_key_fails_clearly(async_client, db, backup_calls):
    calls, responses = backup_calls
    other_key = backup_crypto.generate_backup_private_key()
    link = make_connected_link(db)  # no key yet
    responses["get"] = encrypted_backup_response("b-4", "frames", "Kitchen", other_key, b"{}")

    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": "b-4", "project_id": async_client.project_id},
    )
    assert response.status_code == 409
    assert "recovery key" in response.json()["detail"]

    # A different key on the link → fingerprint mismatch, same guidance.
    cloud_backup.set_link_backup_key(link, backup_crypto.generate_backup_private_key())
    db.commit()
    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": "b-4", "project_id": async_client.project_id},
    )
    assert response.status_code == 409
    assert backup_crypto.backup_key_fingerprint(other_key) in response.json()["detail"]


@pytest.mark.asyncio
async def test_backup_key_endpoints(async_client, db, backup_calls):
    link = make_connected_link(db)

    # Viewing generates the key on first call and returns the recovery code.
    response = await async_client.get("/api/cloud/backup-key")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["recovery_code"].startswith("FRBK1-")
    private_key = backup_crypto.decode_recovery_code(data["recovery_code"])
    assert data["fingerprint"] == backup_crypto.backup_key_fingerprint(private_key)

    status = await async_client.get("/api/cloud/status")
    assert status.json()["backup_key_fingerprint"] == data["fingerprint"]

    # Importing a saved code replaces the key (the reinstall flow).
    other_key = backup_crypto.generate_backup_private_key()
    response = await async_client.post(
        "/api/cloud/backup-key/import",
        json={"recovery_code": backup_crypto.encode_recovery_code(other_key)},
    )
    assert response.status_code == 200, response.text
    assert response.json()["fingerprint"] == backup_crypto.backup_key_fingerprint(other_key)
    assert link_private_key(db, link) == other_key

    response = await async_client.post(
        "/api/cloud/backup-key/import", json={"recovery_code": "not-a-code"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_delete_cloud_backup(async_client, db, backup_calls):
    calls, _ = backup_calls
    make_connected_link(db)
    response = await async_client.delete("/api/cloud/backups/b-9")
    assert response.status_code == 200, response.text
    assert calls["delete"][0][2] == "b-9"


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
