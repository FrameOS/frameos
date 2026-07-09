"""The cloud sync singleton: grants sync, revocation handling, auto backups."""
import base64
import datetime
import json

import pytest

from app.cloud.sync import CloudSync
from app.models import new_frame, update_frame
from app.models.cloud import CloudBackendLink, CloudMembership
from app.utils import cloud_link

PROVIDER = "https://cloud.frameos.net"


def make_connected_link(db, scope="backend:link backend:read backup:frames"):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        scope=scope,
        local_origin="http://test",
        local_fallback_enabled=False,
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
            return responses[name]

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


@pytest.mark.asyncio
async def test_deploy_broadcast_triggers_backup(db, redis, service, cloud_calls):
    calls, _ = cloud_calls
    make_connected_link(db)
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._prime_deploys_seen()  # startup does this before listening

    # A frame update without a deploy stamp does nothing.
    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []

    frame.last_successful_deploy_at = datetime.datetime.utcnow()
    await update_frame(db, redis, frame)
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 1
    _provider, _token, payload = calls["backup_save"][0]
    assert payload["kind"] == "frames"
    assert payload["item_key"] == f"frame-{frame.id}"
    content = json.loads(base64.b64decode(payload["content_base64"]))
    assert content["frame"]["name"] == "Kitchen"
    assert "ssh_pass" not in content["frame"]

    # The same deploy stamp is not pushed twice.
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 1

    # A new deploy is.
    frame.last_successful_deploy_at = datetime.datetime.utcnow() + datetime.timedelta(seconds=5)
    await update_frame(db, redis, frame)
    await service._maybe_backup_frame(frame.to_dict())
    assert len(calls["backup_save"]) == 2


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
    await update_frame(db, redis, frame)

    # Simulate a worker restart: the first event after priming carries a stamp
    # that predates the restart, so nothing is pushed.
    service._prime_deploys_seen()
    await service._maybe_backup_frame(frame.to_dict())
    assert calls["backup_save"] == []
