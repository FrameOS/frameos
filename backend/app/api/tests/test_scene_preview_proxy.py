"""The editor's live-preview HTTP proxy (`scene_preview_proxy`): a scene in the
preview reaches what its frame would reach (#868). A frame managed by this
backend has no local-network block, so its preview reaches the LAN; a virtual
frame only with its local network access on; the backend host's own
loopback and link-local never."""

import base64
import json

import httpx
import pytest

from app.models.frame import Frame
from app.utils import network
from app.utils.embedded_render import preview_network_policy


@pytest.fixture
def upstream(monkeypatch):
    """The proxy's outbound client, faked: records what the guarded transport
    was built with and each request that reached it."""
    seen: dict = {'transports': [], 'requests': []}

    def handler(request: httpx.Request) -> httpx.Response:
        seen['requests'].append(request)
        return httpx.Response(200, content=b'{"ok":true}', headers={'content-type': 'application/json'})

    def fake_guarded_transport(**kwargs):
        seen['transports'].append(kwargs)
        return httpx.MockTransport(handler)

    monkeypatch.setattr(network, 'guarded_transport', fake_guarded_transport)
    return seen


async def new_frame(async_client, db, **payload) -> Frame:
    response = await async_client.post(
        '/api/frames/new', json={'name': 'Frame', 'frame_host': '', 'server_host': 'localhost', **payload}
    )
    assert response.status_code == 200, response.text
    return db.get(Frame, response.json()['frame']['id'])


async def virtual_frame(async_client, db) -> Frame:
    return await new_frame(async_client, db, mode='embedded', platform='virtual')


async def proxy(async_client, frame: Frame, url: str, **envelope):
    return await async_client.post(
        f'/api/frames/{frame.id}/scene_preview_proxy', json={'method': 'GET', 'url': url, **envelope}
    )


def set_lan_access(db, frame: Frame, value) -> None:
    frame.network = {**(frame.network or {}), 'allowLocalNetworkAccess': value}
    db.add(frame)
    db.commit()


# ----------------------------------------------------------------- the policy


@pytest.mark.asyncio
async def test_the_preview_reaches_what_the_frame_would(async_client, db):
    pi = await new_frame(async_client, db, frame_host='pi.local')
    assert preview_network_policy(pi) == 'private'
    esp32 = await new_frame(async_client, db, mode='embedded', platform='esp32-s3')
    assert preview_network_policy(esp32) == 'private'
    c3 = await new_frame(async_client, db, mode='embedded', platform='esp32-c3')
    assert preview_network_policy(c3) == 'private'

    virtual = await virtual_frame(async_client, db)
    assert preview_network_policy(virtual) == 'public'
    virtual.network = {'allowLocalNetworkAccess': True}
    assert preview_network_policy(virtual) == 'private'

    # Off said in so many words is public addresses only, on any frame.
    pi.network = {'allowLocalNetworkAccess': False}
    assert preview_network_policy(pi) == 'public'


# ----------------------------------------------------------------- the route


@pytest.mark.asyncio
async def test_a_frame_on_the_lan_previews_a_lan_service(async_client, db, upstream):
    pi = await new_frame(async_client, db, frame_host='pi.local')
    response = await proxy(
        async_client,
        pi,
        'http://192.168.1.20:2283/api/albums/abc',
        headers={'x-api-key': 'key'},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {'ok': True}
    assert upstream['transports'] == [{'allow_private': True, 'allow_loopback': False}]
    [request] = upstream['requests']
    assert str(request.url) == 'http://192.168.1.20:2283/api/albums/abc'
    assert request.headers['x-api-key'] == 'key'


@pytest.mark.asyncio
async def test_a_virtual_frame_previews_the_lan_only_with_local_network_access_on(async_client, db, upstream):
    virtual = await virtual_frame(async_client, db)
    response = await proxy(async_client, virtual, 'http://192.168.1.20:2283/api/albums/abc')
    assert response.status_code == 403
    assert response.json()['detail'] == 'Proxy target host is not allowed'
    assert upstream['requests'] == []

    set_lan_access(db, virtual, True)
    response = await proxy(async_client, virtual, 'http://192.168.1.20:2283/api/albums/abc')
    assert response.status_code == 200, response.text
    assert upstream['transports'][-1] == {'allow_private': True, 'allow_loopback': False}


@pytest.mark.asyncio
async def test_a_public_service_previews_on_every_frame(async_client, db, upstream):
    virtual = await virtual_frame(async_client, db)
    response = await proxy(
        async_client,
        virtual,
        'https://api.example.com/v1/images',
        method='POST',
        bodyBase64=base64.b64encode(json.dumps({'prompt': 'a cat'}).encode()).decode(),
    )
    assert response.status_code == 200, response.text
    assert upstream['transports'] == [{'allow_private': False, 'allow_loopback': False}]
    [request] = upstream['requests']
    assert request.method == 'POST'
    assert json.loads(request.content) == {'prompt': 'a cat'}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'url',
    [
        'http://127.0.0.1:8989/api/frames',
        'http://[::1]:6379/',
        'http://169.254.169.254/latest/meta-data/',
        'http://0.0.0.0:8989/',
    ],
)
async def test_the_backend_hosts_own_addresses_stay_refused_whatever_the_frame_says(
    async_client, db, upstream, url
):
    virtual = await virtual_frame(async_client, db)
    set_lan_access(db, virtual, True)
    pi = await new_frame(async_client, db, frame_host='pi.local')
    for frame in (virtual, pi):
        response = await proxy(async_client, frame, url)
        assert response.status_code == 403, (frame.id, url, response.text)
    assert upstream['requests'] == []


@pytest.mark.asyncio
async def test_a_frame_with_local_network_access_off_previews_public_addresses_only(async_client, db, upstream):
    pi = await new_frame(async_client, db, frame_host='pi.local')
    set_lan_access(db, pi, False)
    response = await proxy(async_client, pi, 'http://10.0.0.5/')
    assert response.status_code == 403
    assert upstream['requests'] == []
