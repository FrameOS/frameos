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
