import time

import httpx
import pytest

from app.models.frame import new_frame
from app.models.organization import OrganizationMember, Project
from app.utils import network
from app.utils.preview_proxy_token import (
    PREVIEW_PROXY_TOKEN_HEADER,
    PREVIEW_PROXY_TOKEN_TTL_SECONDS,
    mint_preview_proxy_token,
    read_preview_proxy_token,
)


@pytest.fixture
def upstream(monkeypatch):
    """Answers the proxy's outbound request instead of the internet."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, content=b"upstream-bytes", headers={"content-type": "text/x-upstream"})

    monkeypatch.setattr(network, "guarded_transport", lambda **_: httpx.MockTransport(handler))
    return seen


def proxy_path(project_id: int, frame_id: int) -> str:
    return f"/api/projects/{project_id}/frames/{frame_id}/scene_preview_proxy"


ENVELOPE = {"method": "GET", "url": "https://example.com/data", "headers": {"x-api-key": "k"}}


async def mint(async_client, frame_id: int) -> dict:
    response = await async_client.post(f"/api/frames/{frame_id}/scene_preview_proxy/token")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_a_minted_token_opens_the_proxy_without_a_cookie_from_an_opaque_origin(
    async_client, no_auth_client, db, redis, upstream
):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    minted = await mint(async_client, frame.id)
    assert minted["expiresIn"] == PREVIEW_PROXY_TOKEN_TTL_SECONDS
    assert minted["expiresAt"]

    # What a worker in a sandboxed iframe sends: no cookie, no bearer, and
    # the browser's `Origin: null`.
    response = await no_auth_client.post(
        proxy_path(async_client.project_id, frame.id),
        json=ENVELOPE,
        headers={PREVIEW_PROXY_TOKEN_HEADER: minted["token"], "Origin": "null"},
    )
    assert response.status_code == 201, response.text
    assert response.content == b"upstream-bytes"
    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers
    assert upstream[0].url == "https://example.com/data"
    assert upstream[0].headers["x-api-key"] == "k"
    # The token is ours; it never travels on to the upstream.
    assert PREVIEW_PROXY_TOKEN_HEADER.lower() not in {key.lower() for key in upstream[0].headers}


@pytest.mark.asyncio
async def test_the_preflight_allows_the_token_header(no_auth_client, async_client, db, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    response = await no_auth_client.options(
        proxy_path(async_client.project_id, frame.id),
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": f"content-type, {PREVIEW_PROXY_TOKEN_HEADER.lower()}",
        },
    )
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "*"
    assert PREVIEW_PROXY_TOKEN_HEADER in response.headers["access-control-allow-headers"]
    assert response.headers["access-control-allow-methods"] == "POST"


@pytest.mark.asyncio
async def test_without_a_token_or_a_session_the_proxy_answers_401(no_auth_client, async_client, db, redis, upstream):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    response = await no_auth_client.post(proxy_path(async_client.project_id, frame.id), json=ENVELOPE)
    assert response.status_code == 401
    assert upstream == []


@pytest.mark.asyncio
async def test_the_session_still_works_for_bundles_without_a_token(async_client, db, redis, upstream):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    response = await async_client.post(f"/api/frames/{frame.id}/scene_preview_proxy", json=ENVELOPE)
    assert response.status_code == 201, response.text
    assert response.content == b"upstream-bytes"
    # A cookie or bearer request is not opened up to other origins.
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.asyncio
async def test_a_stale_token_falls_back_to_the_session(async_client, db, redis, upstream):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    expired, _ = mint_preview_proxy_token(
        project_id=async_client.project_id,
        frame_id=frame.id,
        user_id=1,
        now=time.time() - 2 * PREVIEW_PROXY_TOKEN_TTL_SECONDS,
    )
    response = await async_client.post(
        f"/api/frames/{frame.id}/scene_preview_proxy",
        json=ENVELOPE,
        headers={PREVIEW_PROXY_TOKEN_HEADER: expired},
    )
    assert response.status_code == 201, response.text


@pytest.mark.asyncio
async def test_expired_tampered_and_misdirected_tokens_are_refused(async_client, no_auth_client, db, redis, upstream):
    kitchen = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    hall = await new_frame(db, redis, "Hall", "localhost", "localhost")
    project_id = async_client.project_id
    token = (await mint(async_client, kitchen.id))["token"]
    user_id = read_preview_proxy_token(token).user_id

    expired, _ = mint_preview_proxy_token(
        project_id=project_id,
        frame_id=kitchen.id,
        user_id=user_id,
        now=time.time() - PREVIEW_PROXY_TOKEN_TTL_SECONDS - 1,
    )
    tampered = token[:-1] + ("0" if token[-1] != "0" else "1")
    stretched = token.split(".")
    stretched[4] = str(int(stretched[4]) + 3600)
    # Same organization, so the user may see it: the token still names Kitchen's project only.
    other_project = Project(organization_id=db.get(Project, project_id).organization_id, name="Other")
    db.add(other_project)
    db.commit()
    db.refresh(other_project)
    cases = {
        "expired": (expired, proxy_path(project_id, kitchen.id)),
        "tampered": (tampered, proxy_path(project_id, kitchen.id)),
        "stretched expiry": (".".join(stretched), proxy_path(project_id, kitchen.id)),
        "another frame": (token, proxy_path(project_id, hall.id)),
        "another project": (token, proxy_path(other_project.id, kitchen.id)),
        "a login JWT": (async_client.headers["Authorization"].split(" ", 1)[1], proxy_path(project_id, kitchen.id)),
        "garbage": ("pp1.not.a.token", proxy_path(project_id, kitchen.id)),
    }
    for name, (candidate, path) in cases.items():
        response = await no_auth_client.post(path, json=ENVELOPE, headers={PREVIEW_PROXY_TOKEN_HEADER: candidate})
        assert response.status_code == 401, name
        assert response.json()["detail"] == "Preview token expired or invalid", name
        # The opaque-origin worker must be able to read why it was refused.
        assert response.headers["access-control-allow-origin"] == "*", name
    assert upstream == []


@pytest.mark.asyncio
async def test_a_token_dies_with_its_users_access_to_the_project(async_client, no_auth_client, db, redis, upstream):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    token = (await mint(async_client, frame.id))["token"]
    db.query(OrganizationMember).delete()
    db.commit()
    response = await no_auth_client.post(
        proxy_path(async_client.project_id, frame.id),
        json=ENVELOPE,
        headers={PREVIEW_PROXY_TOKEN_HEADER: token},
    )
    assert response.status_code == 401
    assert upstream == []


@pytest.mark.asyncio
async def test_a_preview_token_is_not_a_login(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    token = (await mint(async_client, frame.id))["token"]
    response = await no_auth_client.get(
        f"/api/projects/{async_client.project_id}/frames",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_minting_takes_a_session_and_a_frame_of_the_project(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    refused = await no_auth_client.post(
        f"/api/projects/{async_client.project_id}/frames/{frame.id}/scene_preview_proxy/token"
    )
    assert refused.status_code == 401
    missing = await async_client.post("/api/frames/999999/scene_preview_proxy/token")
    assert missing.status_code == 404


def test_tokens_read_back_what_they_were_minted_with():
    token, expires_at = mint_preview_proxy_token(project_id=3, frame_id=7, user_id=11, now=1_000_000)
    grant = read_preview_proxy_token(token, now=1_000_000)
    assert grant is not None
    assert (grant.project_id, grant.frame_id, grant.user_id, grant.expires_at) == (3, 7, 11, expires_at)
    assert expires_at == 1_000_000 + PREVIEW_PROXY_TOKEN_TTL_SECONDS
    assert read_preview_proxy_token(token, now=expires_at + 1) is None
    ingress, _ = mint_preview_proxy_token(project_id=3, frame_id=7, user_id=None, now=1_000_000)
    assert read_preview_proxy_token(ingress, now=1_000_000).user_id is None
    for bad in ("", "pp1", "pp2" + token[3:], token + ".x", token.replace(".7.", ".8.")):
        assert read_preview_proxy_token(bad, now=1_000_000) is None, bad
