"""The cloud sync singleton: grants sync, revocation handling, auto backups."""
import base64
import datetime
import json

import pytest

from app.cloud.sync import CloudSync
from app.models import new_frame, update_frame
from app.models.cloud import CloudBackendLink, CloudMembership
from app.utils import cloud_backup, cloud_link

PROVIDER = "https://cloud.frameos.net"


def make_connected_link(db, scope="backend:link backend:read backup:frames", backup_frames_enabled=True):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        scope=scope,
        local_origin="http://test",
        local_fallback_enabled=False,
        backup_frames_enabled=backup_frames_enabled,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@pytest.fixture
def service():
    return CloudSync()


@pytest.fixture
def cloud_calls(monkeypatch):
    calls = {"grants": [], "inventory": [], "backup_save": []}
    responses = {
        "grants": (
            200,
            {
                "grants": [
                    {"account_id": "acc-1", "account_email": "owner@example.com", "role": "owner"},
                    {"account_id": "acc-2", "account_email": "guest@example.com", "role": "member"},
                ]
            },
        ),
        "inventory": (200, {"status": "synced"}),
        "backup_save": (200, {"status": "saved", "backup": {"id": "b-1"}}),
    }

    def make(name):
        async def call(*args):
            calls[name].append(args)
            response = responses[name]
            if isinstance(response, Exception):
                raise response
            return response

        return call

    monkeypatch.setattr(cloud_link, "backend_grants", make("grants"))
    monkeypatch.setattr(cloud_link, "backend_inventory", make("inventory"))
    monkeypatch.setattr(cloud_link, "backup_save", make("backup_save"))
    return calls, responses


@pytest.mark.asyncio
async def test_sync_link_updates_grants_and_memberships(db, service, cloud_calls):
    link = make_connected_link(db)
    await service._sync_link()

    db.expire_all()
    link = db.get(CloudBackendLink, link.id)
    assert link.cloud_account_id == "acc-1"
    assert link.cloud_account_email == "owner@example.com"
    assert link.last_grant_sync_at is not None
    assert link.last_inventory_sync_at is not None

    memberships = db.query(CloudMembership).order_by(CloudMembership.cloud_account_id).all()
    assert [(m.cloud_account_id, m.role) for m in memberships] == [("acc-1", "owner"), ("acc-2", "member")]

    # A removed grant disappears on the next sync.
    calls, responses = cloud_calls
    responses["grants"] = (200, {"grants": [{"account_id": "acc-1", "role": "owner"}]})
    await service._sync_link()
    db.expire_all()
    memberships = db.query(CloudMembership).all()
    assert [m.cloud_account_id for m in memberships] == ["acc-1"]


@pytest.mark.asyncio
async def test_sync_link_handles_revocation(db, service, cloud_calls):
    calls, responses = cloud_calls
    link = make_connected_link(db)
    assert link.local_fallback_enabled is False

    responses["grants"] = (401, {"error": "invalid_link_token"})
    await service._sync_link()

    db.expire_all()
    link = db.get(CloudBackendLink, link.id)
    assert link.status == "disconnected"
    assert link.poll_error == "revoked"
    assert link.access_token is None
    # Revocation must never lock the install: local login comes back.
    assert link.local_fallback_enabled is True


@pytest.mark.asyncio
async def test_sync_link_keeps_state_on_network_error(db, service, monkeypatch):
    link = make_connected_link(db)

    async def boom(*_args):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(cloud_link, "backend_grants", boom)
    await service._sync_link()

    db.expire_all()
    link = db.get(CloudBackendLink, link.id)
    assert link.status == "connected"


# ---- secret key rotation ------------------------------------------------------


def test_rotating_secret_key_without_migration_keys_breaks_the_link(db, monkeypatch):
    """The failure mode this guards: SECRET_KEY changes, the token becomes
    undecryptable, and the link silently does nothing while still reporting
    "connected". It must at least be reported."""
    link = make_connected_link(db)
    monkeypatch.setattr(cloud_link.config, "SECRET_KEY", "a-brand-new-secret-key")
    monkeypatch.setattr(cloud_link.config, "CLOUD_SECRET_KEY", "")
    monkeypatch.setattr(cloud_link.config, "PREVIOUS_SECRET_KEYS", [])

    loaded, token, _ = CloudSync()._load_link()
    assert token is None
    db.refresh(link)
    assert link.poll_error == "secret_key_changed"


def test_previous_secret_keys_recover_and_migrate_the_token(db, monkeypatch):
    """Naming the old key recovers the link, and the token is re-encrypted with
    the new one so the old key can be dropped."""
    link = make_connected_link(db)
    original = link.access_token
    old_key = cloud_link.config.SECRET_KEY
    monkeypatch.setattr(cloud_link.config, "SECRET_KEY", "a-brand-new-secret-key")
    monkeypatch.setattr(cloud_link.config, "CLOUD_SECRET_KEY", "")
    monkeypatch.setattr(cloud_link.config, "PREVIOUS_SECRET_KEYS", [old_key])

    loaded, token, _ = CloudSync()._load_link()
    assert token == "link-token-secret"
    db.refresh(link)
    assert link.poll_error is None
    assert link.access_token != original  # migrated to the current key

    # Now decryptable without the old key at all.
    monkeypatch.setattr(cloud_link.config, "PREVIOUS_SECRET_KEYS", [])
    assert cloud_link.decrypt_cloud_secret(link.access_token) == "link-token-secret"


def test_cloud_secret_key_decouples_cloud_secrets_from_secret_key(db, monkeypatch):
    """With CLOUD_SECRET_KEY set, SECRET_KEY can be rotated freely."""
    monkeypatch.setattr(cloud_link.config, "CLOUD_SECRET_KEY", "a-dedicated-cloud-key")
    encrypted = cloud_link.encrypt_cloud_secret("link-token-secret")

    monkeypatch.setattr(cloud_link.config, "SECRET_KEY", "rotated-again")
    assert cloud_link.decrypt_cloud_secret(encrypted) == "link-token-secret"
    assert cloud_link.rewrap_cloud_secret(encrypted) is None  # nothing to migrate
@pytest.mark.asyncio
async def test_deploy_broadcast_triggers_backup(db, redis, service, cloud_calls):
    calls, _ = cloud_calls
    link = make_connected_link(db)
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._prime_deploys_seen()  # startup does this before listening

    # A frame update without a deploy stamp does nothing.
    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []

    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    await update_frame(db, redis, frame)
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 1
    db.refresh(frame)
    assert frame.last_cloud_backup_deploy_at == frame.last_successful_deploy_at
    _provider, _token, payload = calls["backup_save"][0]
    assert payload["kind"] == "frames"
    assert payload["item_key"] == f"frame-{frame.id}"
    # The worker generated the backup key on first use and sealed the payload.
    envelope = json.loads(base64.b64decode(payload["content_base64"]))
    assert envelope["format"] == "frameos-encrypted-backup-v1"
    assert envelope["meta"]["name"] == "Kitchen"
    db.expire_all()
    private_key = cloud_backup.link_backup_private_key(db.get(CloudBackendLink, link.id))
    inner = json.loads(cloud_backup.decrypt_backup_content(private_key, envelope))
    assert inner["frame"]["name"] == "Kitchen"
    assert "ssh_pass" not in inner["frame"]

    # The same deploy stamp is not pushed twice.
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 1

    # A new deploy is.
    frame.last_successful_deploy_at = datetime.datetime.utcnow() + datetime.timedelta(seconds=5)
    await update_frame(db, redis, frame)
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 2


@pytest.mark.asyncio
async def test_deploy_backup_needs_the_local_switch(db, redis, service, cloud_calls):
    """The backup:frames scope alone must not upload anything."""
    calls, _ = cloud_calls
    make_connected_link(db, backup_frames_enabled=False)
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._prime_deploys_seen()

    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    await update_frame(db, redis, frame)
    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []


@pytest.mark.asyncio
async def test_failed_deploy_backup_retries_after_worker_restart(db, redis, service, cloud_calls):
    calls, responses = cloud_calls
    make_connected_link(db)
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._prime_deploys_seen()
    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    await update_frame(db, redis, frame)

    responses["backup_save"] = RuntimeError("connection reset")
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 1
    db.refresh(frame)
    assert frame.last_cloud_backup_deploy_at is None

    restarted_service = CloudSync()
    restarted_service._prime_deploys_seen()
    responses["backup_save"] = (503, {"error": "temporarily_unavailable"})
    await restarted_service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 2

    responses["backup_save"] = (200, {"status": "saved"})
    await restarted_service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 3
    db.refresh(frame)
    assert frame.last_cloud_backup_deploy_at == frame.last_successful_deploy_at

    await restarted_service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 3


@pytest.mark.asyncio
async def test_deploy_backup_needs_scope(db, redis, service, cloud_calls):
    calls, _ = cloud_calls
    make_connected_link(db, scope="backend:link backend:read")
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._prime_deploys_seen()
    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    await update_frame(db, redis, frame)

    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []


@pytest.mark.asyncio
async def test_priming_prevents_startup_backup_storm(db, redis, service, cloud_calls):
    calls, _ = cloud_calls
    make_connected_link(db)
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    frame.last_cloud_backup_deploy_at = frame.last_successful_deploy_at
    await update_frame(db, redis, frame)

    # Simulate a worker restart: the first event after priming carries a stamp
    # that predates the restart, so nothing is pushed.
    service._prime_deploys_seen()
    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []
