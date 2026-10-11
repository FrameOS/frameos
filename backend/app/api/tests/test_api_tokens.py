"""Personal API tokens: minted behind a browser session and the password,
shown once, accepted wherever a login is, read-only ones refused for
mutations, revocable, expiring."""
import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.api_token import ApiToken
from app.models import new_frame
from app.models.frame import Frame


async def mint(client, name="laptop", access="full", password="testpassword", **extra):
    body = {"name": name, "access": access, **extra}
    if password is not None:
        body["current_password"] = password
    return await client.post("/api/user/api_tokens", json=body)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_mint_needs_the_password_and_returns_the_secret_once(async_client, db: Session):
    refused = await mint(async_client, password=None)
    assert refused.status_code == 400
    assert "password" in refused.json()["detail"].lower()

    wrong = await mint(async_client, password="nope")
    assert wrong.status_code == 400

    response = await mint(async_client, name="  laptop  ")
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["token"].startswith("fb_api_")
    assert payload["api_token"]["name"] == "laptop"
    assert payload["api_token"]["access"] == "full"
    assert payload["api_token"]["hint"] == payload["token"][: len("fb_api_") + 4]
    assert payload["api_token"]["expires_at"] is not None

    listing = (await async_client.get("/api/user/api_tokens")).json()
    assert [row["id"] for row in listing["api_tokens"]] == [payload["api_token"]["id"]]
    assert listing["live_count"] == 1
    assert listing["can_create"] is True
    assert listing["mcp_url"].endswith("/api/mcp")
    assert listing["default_ttl_days"] == 90
    # Only the hash is stored.
    row = db.query(ApiToken).one()
    assert payload["token"] not in (row.token_hash, row.hint)


@pytest.mark.asyncio
async def test_token_is_accepted_wherever_the_login_is(async_client, db: Session, redis):
    token = (await mint(async_client)).json()["token"]
    await new_frame(db, redis, "Kitchen", "localhost", "localhost")

    me = await async_client.get("/api/user", headers=bearer(token))
    assert me.status_code == 200
    assert me.json()["email"] == "test@example.com"

    frames = await async_client.get("/api/frames", headers=bearer(token))
    assert frames.status_code == 200
    assert [frame["name"] for frame in frames.json()["frames"]] == ["Kitchen"]

    # The cookie-or-bearer routes on api_open honour it too.
    image = await async_client.get(
        f"/api/projects/{async_client.project_id}/frames/{frames.json()['frames'][0]['id']}/scene_images/nope",
        headers=bearer(token),
    )
    assert image.status_code == 200

    db.expire_all()
    assert db.query(ApiToken).one().last_used_at is not None


@pytest.mark.asyncio
async def test_read_only_token_may_only_read(async_client, db: Session, redis):
    token = (await mint(async_client, access="read_only")).json()["token"]
    assert token.startswith("fb_apiro_")
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")

    assert (await async_client.get(f"/api/frames/{frame.id}", headers=bearer(token))).status_code == 200

    refused = await async_client.post(f"/api/frames/{frame.id}", json={"name": "Hall"}, headers=bearer(token))
    assert refused.status_code == 403
    assert refused.json()["detail"]["error"] == "read_only_token"
    db.expire_all()
    stored = db.get(Frame, frame.id)
    assert stored is not None and stored.name == "Kitchen"


@pytest.mark.asyncio
async def test_token_cannot_mint_tokens_or_change_the_login(async_client, db: Session):
    token = (await mint(async_client)).json()["token"]

    minted = await async_client.post(
        "/api/user/api_tokens", json={"name": "escalation", "current_password": "testpassword"}, headers=bearer(token)
    )
    assert minted.status_code == 403
    assert minted.json()["detail"]["error"] == "api_token_not_allowed"

    password = await async_client.post(
        "/api/user/password",
        json={"current_password": "testpassword", "password": "newpassword1", "password2": "newpassword1"},
        headers=bearer(token),
    )
    assert password.status_code == 403
    assert password.json()["detail"]["error"] == "api_token_not_allowed"

    email = await async_client.post(
        "/api/user/email", json={"email": "other@example.com", "current_password": "testpassword"}, headers=bearer(token)
    )
    assert email.status_code == 403
    assert db.query(ApiToken).count() == 1


@pytest.mark.asyncio
async def test_revoked_expired_and_forged_tokens_are_refused(async_client, db: Session):
    created = (await mint(async_client)).json()
    token = created["token"]
    assert (await async_client.get("/api/user", headers=bearer(token))).status_code == 200

    # A token may revoke itself.
    revoked = await async_client.delete(f"/api/user/api_tokens/{created['api_token']['id']}", headers=bearer(token))
    assert revoked.status_code == 200
    assert (await async_client.get("/api/user", headers=bearer(token))).status_code == 401
    again = await async_client.delete(f"/api/user/api_tokens/{created['api_token']['id']}")
    assert again.status_code == 404
    listing = (await async_client.get("/api/user/api_tokens")).json()
    assert listing["api_tokens"][0]["revoked_at"] is not None
    assert listing["live_count"] == 0

    expired = (await mint(async_client, name="old")).json()
    row = db.query(ApiToken).filter(ApiToken.id == expired["api_token"]["id"]).one()
    row.expires_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=1)
    db.commit()
    assert (await async_client.get("/api/user", headers=bearer(expired["token"]))).status_code == 401

    # A full-access prefix on a row that says read_only is a forgery.
    forged = (await mint(async_client, name="forged")).json()
    row = db.query(ApiToken).filter(ApiToken.id == forged["api_token"]["id"]).one()
    row.access = "read_only"
    db.commit()
    assert (await async_client.get("/api/user", headers=bearer(forged["token"]))).status_code == 401

    assert (await async_client.get("/api/user", headers=bearer("fb_api_not-a-token"))).status_code == 401


@pytest.mark.asyncio
async def test_expiry_bounds_and_the_per_user_cap(async_client, monkeypatch):
    assert (await mint(async_client, expires_in_days=0)).status_code == 422
    assert (await mint(async_client, expires_in_days=400)).status_code == 422
    assert (await mint(async_client, expires_in_days=None)).status_code == 201

    monkeypatch.setattr("app.api.api_tokens.MAX_API_TOKENS_PER_USER", 1)
    capped = await mint(async_client, name="second")
    assert capped.status_code == 400
    assert "Revoke one first" in capped.json()["detail"]


@pytest.mark.asyncio
async def test_tokens_need_a_login(no_auth_client):
    assert (await no_auth_client.get("/api/user/api_tokens")).status_code == 401
    assert (await no_auth_client.post("/api/user/api_tokens", json={"name": "x"})).status_code == 401
