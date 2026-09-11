"""Self-hosted backend request-layer fixes from the 2026-09 review: the
bootstrap URL expires, the Remote secret is kept and never minted per read,
an inner 400 is not re-wrapped as a 500, and the dead token / enhance paths
are gone."""

from urllib.parse import urlparse

import pytest

from app.api import frame_bootstrap
from app.models import new_frame
from app.models.frame import Frame, ensure_agent_shared_secret, get_frame_json


# ── bootstrap URL is time-limited ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_bootstrap_url_expires(async_client, no_auth_client, db, redis, monkeypatch):
    frame = await new_frame(db, redis, 'ExpiringBootstrap', 'frame.local', 'backend.local')
    now = 1_800_000_000.0
    monkeypatch.setattr(frame_bootstrap, "_now", lambda: now)

    response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap')
    assert response.status_code == 200
    script_path = urlparse(response.json()['script_url']).path
    token = script_path.rsplit('/', 1)[1]
    expires_text, signature = token.split('.', 1)
    assert int(expires_text) == int(now) + frame_bootstrap.FRAME_BOOTSTRAP_TOKEN_TTL_SECONDS

    assert (await no_auth_client.get(script_path)).status_code == 200

    # One second past the expiry the same link is dead.
    monkeypatch.setattr(
        frame_bootstrap, "_now", lambda: now + frame_bootstrap.FRAME_BOOTSTRAP_TOKEN_TTL_SECONDS + 1
    )
    assert (await no_auth_client.get(script_path)).status_code == 404


@pytest.mark.asyncio
async def test_bootstrap_url_expiry_cannot_be_stretched_and_old_links_are_dead(
    async_client, no_auth_client, db, redis
):
    frame = await new_frame(db, redis, 'StretchBootstrap', 'frame.local', 'backend.local')
    response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap')
    script_path = urlparse(response.json()['script_url']).path
    prefix, token = script_path.rsplit('/', 1)
    expires_text, signature = token.split('.', 1)
    db.refresh(frame)

    # A later expiry under the same signature does not verify.
    stretched = f"{prefix}/{int(expires_text) + 60}.{signature}"
    assert (await no_auth_client.get(stretched)).status_code == 404
    # Nor does one past the TTL even with a matching signature.
    far = int(expires_text) + frame_bootstrap.FRAME_BOOTSTRAP_TOKEN_TTL_SECONDS
    far_token = f"{far}.{frame_bootstrap._frame_bootstrap_signature(frame, far)}"
    assert (await no_auth_client.get(f"{prefix}/{far_token}")).status_code == 404
    # The pre-expiry form — a bare HMAC over id, API key and secret — was a
    # permanent bearer; links handed out before this change stop working.
    import hashlib
    import hmac

    from app.config import config

    legacy = hmac.new(
        str(config.SECRET_KEY).encode(),
        f"{frame.id}:{frame.server_api_key}:{frame.agent['agentSharedSecret']}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert (await no_auth_client.get(f"{prefix}/{legacy}")).status_code == 404
    for junk in ("", ".", "abc.def", f"{expires_text}.", f".{signature}"):
        assert not frame_bootstrap._frame_bootstrap_token_valid(frame, junk)


# ── agentSharedSecret: persisted, never minted per read ────────────────────


@pytest.mark.asyncio
async def test_get_frame_json_does_not_mint_a_remote_secret(db, redis):
    frame = await new_frame(db, redis, 'NoSecretFrame', 'frame.local', 'backend.local')
    frame.agent = {'agentEnabled': True, 'agentRunCommands': True}
    db.add(frame)
    db.commit()

    first = get_frame_json(db, frame)['agent']['agentSharedSecret']
    second = get_frame_json(db, frame)['agent']['agentSharedSecret']
    # It used to be a fresh random value on every call, never stored, so the
    # Remote that got it could never pass the handshake.
    assert first == second == ""

    frame.agent = {**frame.agent, 'agentSharedSecret': 'stored'}
    db.add(frame)
    db.commit()
    assert get_frame_json(db, frame)['agent']['agentSharedSecret'] == 'stored'


@pytest.mark.asyncio
async def test_frame_update_keeps_the_remote_secret_a_caller_left_out(async_client, db, redis):
    frame = await new_frame(db, redis, 'KeepSecretFrame', 'frame.local', 'backend.local')
    stored_secret = frame.agent['agentSharedSecret']
    assert stored_secret

    # `agent` is written whole; a caller that sends it without the secret
    # (or with an empty one) must not wipe the stored value.
    for agent in (
        {'agentEnabled': True, 'agentRunCommands': True},
        {'agentEnabled': True, 'agentRunCommands': True, 'agentSharedSecret': ''},
    ):
        response = await async_client.post(f'/api/frames/{frame.id}', json={'agent': agent})
        assert response.status_code == 200

    db.expire_all()
    stored = db.get(Frame, frame.id)
    assert stored.agent['agentEnabled'] is True
    assert stored.agent['agentSharedSecret'] == stored_secret
    assert get_frame_json(db, stored)['agent']['agentSharedSecret'] == stored_secret


@pytest.mark.asyncio
async def test_frame_update_persists_a_secret_when_none_is_stored(async_client, db, redis):
    frame = await new_frame(db, redis, 'MintOnceFrame', 'frame.local', 'backend.local')
    frame.agent = {'agentEnabled': False}
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}', json={'agent': {'agentEnabled': True, 'agentRunCommands': True}}
    )
    assert response.status_code == 200
    db.expire_all()
    stored = db.get(Frame, frame.id)
    minted = stored.agent['agentSharedSecret']
    assert minted
    # Persisted: every later frame.json carries the same value.
    assert get_frame_json(db, stored)['agent']['agentSharedSecret'] == minted
    assert get_frame_json(db, stored)['agent']['agentSharedSecret'] == minted


def test_ensure_agent_shared_secret():
    assert ensure_agent_shared_secret({'agentSharedSecret': 'new'}, {'agentSharedSecret': 'old'}) == {
        'agentSharedSecret': 'new'
    }
    assert ensure_agent_shared_secret({'agentEnabled': True}, {'agentSharedSecret': 'old'}) == {
        'agentEnabled': True,
        'agentSharedSecret': 'old',
    }
    assert ensure_agent_shared_secret({'agentSharedSecret': ''}, {'agentSharedSecret': 'old'})[
        'agentSharedSecret'
    ] == 'old'
    minted = ensure_agent_shared_secret(None, None)['agentSharedSecret']
    assert isinstance(minted, str) and len(minted) >= 32


# ── HTTPException is not re-wrapped as a 500 ───────────────────────────────


@pytest.mark.asyncio
async def test_deploy_plan_unknown_mode_is_a_400_not_a_500(async_client, db, redis):
    frame = await new_frame(db, redis, 'PlanModeFrame', 'frame.local', 'backend.local')

    response = await async_client.get(f'/api/frames/{frame.id}/deploy_plan?mode=bogus')
    assert response.status_code == 400
    assert response.json()['detail'] == "mode must be 'combined', 'full' or 'fast'"

    response = await async_client.post(f'/api/frames/{frame.id}/deploy_plan?mode=bogus', json={})
    assert response.status_code == 400


# ── dead paths removed ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_enhance_source_route_is_gone(async_client):
    response = await async_client.post('/api/apps/enhance_source', json={'source': 'x', 'prompt': 'y'})
    assert response.status_code in (404, 405)


@pytest.mark.asyncio
async def test_public_image_routes_take_no_url_token(async_client, no_auth_client, db, redis):
    """Nothing minted the scoped JWTs these routes accepted as `?token=`, so
    the branch only ever answered 401; without it a session is the one way in."""
    frame = await new_frame(db, redis, 'TokenlessFrame', 'frame.local', 'backend.local')
    project_id = frame.project_id
    for path in (
        f'/api/projects/{project_id}/frames/{frame.id}/image?token=anything',
        f'/api/projects/{project_id}/frames/{frame.id}/asset?path=a.png&token=anything',
        f'/api/projects/{project_id}/frames/{frame.id}/scene_images/scene-1?token=anything',
        f'/api/projects/{project_id}/templates/missing/image?token=anything',
        '/api/repositories/system/samples/templates/missing/image?token=anything',
    ):
        response = await no_auth_client.get(path)
        assert response.status_code == 401, path


# ── chat ids: never stored as the caller sent them ─────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path, extra",
    [
        # Spelled project-scoped: the test client does not rewrite /api/ai/.
        ("ai/apps/chat", {"sources": {"app.nim": "discard"}, "sceneId": "s", "nodeId": "n"}),
        ("ai/scenes/chat", {}),
    ],
)
async def test_ai_chat_stores_a_project_derived_id_not_the_callers(async_client, db, redis, path, extra):
    from app.models.chat import Chat, ChatMessage, project_chat_id
    from app.models.organization import Project

    frame = await new_frame(db, redis, 'ChatFrame', 'frame.local', 'backend.local')
    project_id = frame.project_id
    local_id = "11111111-2222-4333-8444-555555555555"
    path = f"/api/projects/{project_id}/{path}"
    chats_path = f"/api/projects/{project_id}/ai/chats"
    body = {"prompt": "hello", "frameId": frame.id, "chatId": local_id, **extra}

    # No OpenAI key is set, so the route answers 400 — after it has stored the
    # chat and the user's message, which is the part under test.
    first = await async_client.post(path, json=body)
    second = await async_client.post(path, json=body)
    assert first.status_code == second.status_code == 400

    derived = project_chat_id(project_id, local_id)
    assert derived != local_id
    chats = db.query(Chat).filter(Chat.project_id == project_id).all()
    assert [chat.id for chat in chats] == [derived]
    assert db.query(ChatMessage).filter(ChatMessage.chat_id == derived).count() == 2

    # The browser keeps using the id it proposed; it resolves to the chat.
    detail = await async_client.get(f"{chats_path}/{local_id}")
    assert detail.status_code == 200
    assert detail.json()["chat"]["id"] == derived
    assert (await async_client.get(f"{chats_path}/{derived}")).status_code == 200

    # An id that exists in another project answers exactly like a fresh one:
    # no collision (it used to 500 on the primary key), no sign of the other
    # project's chat, which stays untouched.
    other_project = Project(name="Other", organization_id=db.get(Project, project_id).organization_id)
    db.add(other_project)
    db.commit()
    other_frame = await new_frame(db, redis, 'OtherFrame', 'o.local', 'backend.local', project_id=other_project.id)
    foreign = Chat(id="99999999-8888-4777-8666-555555555555", project_id=other_project.id, frame_id=other_frame.id)
    db.add(foreign)
    db.commit()
    probe = await async_client.post(path, json={**body, "chatId": foreign.id})
    assert probe.status_code == 400
    assert db.query(Chat).filter(Chat.project_id == project_id, Chat.id == foreign.id).count() == 0
    assert db.query(Chat).filter(Chat.id == project_chat_id(project_id, foreign.id)).count() == 1
    assert db.query(ChatMessage).filter(ChatMessage.chat_id == foreign.id).count() == 0
    assert (await async_client.get(f"{chats_path}/{foreign.id}")).json()["chat"]["id"] != foreign.id
