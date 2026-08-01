"""The cloud sync singleton: grants sync and revocation handling."""
import pytest

from app.cloud.sync import CloudSync
from app.models.cloud import CloudBackendLink, CloudMembership
from app.utils import cloud_link

PROVIDER = "https://cloud.frameos.net"


def make_connected_link(db, scope="backend:link backend:read"):
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
    calls = {"grants": [], "inventory": []}
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
