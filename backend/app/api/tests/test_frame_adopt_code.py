"""Adoption by the code a frame draws on its panel: POST /api/frames/adopt
with `code` (docs/api-triality.md). The frame's side is faked: GET
/api/adopt says what it is, POST /api/adopt takes the code."""

import asyncio
import json
import re
from unittest.mock import AsyncMock, patch
from urllib.parse import unquote

import pytest
from fastapi import HTTPException

from app.models.frame import Frame
from app.models.log import Log
from app.models.settings import Settings
from app.tasks.embedded_firmware import embedded_device_for_panel, embedded_panel_for_device
from app.utils import embedded_scene_import


def _body(**overrides):
    return {
        'frame_host': '10.0.0.42',
        'code': '123456',
        'server_host': '10.0.0.5:8989',
        **overrides,
    }


def _linux_device_payload():
    return {
        'id': 1,
        'name': 'Kitchen frame',
        'mode': 'rpios',
        'frame_host': '10.0.0.42',
        'frame_port': 8787,
        'frame_access': 'private',
        'frame_access_key': 'device-web-key',
        'server_host': '',
        'server_port': 8989,
        'server_api_key': '',
        'width': 800,
        'height': 480,
        'device': 'pimoroni.inky_impression_13',
        'interval': 300.0,
        'rotate': 0,
        'scenes': [{'id': 'scene-1', 'name': 'Device scene', 'nodes': [], 'edges': []}],
    }


class FakeFrame:
    """One frame on the network: the adoption routes, for a Pi the admin API
    the password flow continues on, and for an ESP32 its scene store
    (`board_scenes`, read with the key it was given once it is back up,
    `scene_reads_refused` reads later). `ports` are where it answers."""

    def __init__(self, adopt_info, *, ports=(8787,), claim=None, board_scenes=(), scene_reads_refused=0,
                 linux_payload=None, settings_status=200):
        self.adopt_info = adopt_info
        self.ports = set(ports)
        self.claim = claim or (lambda body: (200, {'username': 'admin', 'password': 'minted-pass'}))
        self.board_scenes = list(board_scenes)
        self.scene_reads_refused = scene_reads_refused
        self.linux_payload = linux_payload or _linux_device_payload()
        self.settings_status = settings_status
        self.calls = []  # (method, port, path, body)
        self.logins = []
        self.posted = []
        self.settings_posted = []

    async def fetch(self, frame_obj, redis_obj, *, path, method='GET', body=None, headers=None, **kwargs):
        port = frame_obj.frame_port
        parsed = json.loads(body) if body else None
        self.calls.append((method, port, path, parsed))
        if port not in self.ports:
            raise HTTPException(status_code=502, detail='All connection attempts failed')
        scene_read = re.fullmatch(r'/api/frames/(\d+)/scenes(?:/(.+))?', path)
        if scene_read and method == 'GET':
            # The row's key and id are what the board was told.
            assert frame_obj.mode == 'embedded' and frame_obj.server_api_key
            assert int(scene_read.group(1)) == frame_obj.id
            if self.scene_reads_refused:
                self.scene_reads_refused -= 1
                raise HTTPException(status_code=502, detail='All connection attempts failed')
            if scene_read.group(2) is None:
                listing = {
                    'scenes': [{'id': scene['id'], 'name': scene['name'], 'slot': index}
                               for index, scene in enumerate(self.board_scenes)],
                    'storage': {'sceneCount': len(self.board_scenes)},
                }
                return 200, json.dumps(listing).encode(), {}
            scene_id = unquote(scene_read.group(2))
            scene = next(scene for scene in self.board_scenes if scene['id'] == scene_id)
            return 200, json.dumps(scene).encode(), {}
        if path == '/api/adopt':
            # The code is the only credential: nothing else goes out.
            assert not (headers or {}).get('Authorization')
            assert kwargs.get('attempts') == 1
            if method == 'GET':
                return 200, json.dumps(self.adopt_info).encode(), {'content-type': 'application/json'}
            status, answer = self.claim(parsed)
            return status, json.dumps(answer).encode(), {'content-type': 'application/json'}
        if path == '/api/admin/login':
            self.logins.append(parsed)
            return 200, b'{"status":"ok"}', {'set-cookie': 'frame_admin_session=s; Path=/'}
        if path == '/event/restart':
            return 200, b'{"status":"ok"}', {}
        if path == '/api/settings' and method == 'POST':
            # The Pi's service-key route (admin_api_routes.nim).
            self.settings_posted.append(parsed)
            return self.settings_status, b'{}', {}
        if path.startswith('/api/frames/1'):
            if method == 'POST':
                self.posted.append(parsed)
                return 200, b'{"message":"ok"}', {}
            return 200, json.dumps({'frame': self.linux_payload}).encode(), {}
        raise AssertionError(f'unexpected {method} {path}')


def _patched(fake):
    return patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=fake.fetch))


@pytest.fixture(autouse=True)
def _board_back_at_once(monkeypatch):
    """The adoption's wait for a restarting board, without the wait."""
    monkeypatch.setattr('app.api.frame_sync.ADOPT_SCENE_IMPORT_RETRY_SECONDS', 0)
    monkeypatch.setattr('app.api.frame_sync.ADOPT_SCENE_IMPORT_WAIT_SECONDS', 0.3)


async def _background_imports_done():
    await asyncio.gather(*list(embedded_scene_import._background_imports))


LINUX_INFO = {'adopting': True, 'kind': 'linux', 'platform': 'linux', 'name': 'Kitchen frame', 'version': '2026.11.11'}
ESP32_INFO = {
    'adopting': True,
    'kind': 'embedded',
    'platform': 'esp32-s3',
    'name': 'FrameOS frame',
    'version': '2026.11.11',
    'panel': 'EPD_7in3e',
    'hardwarePreset': 'seeed_reterminal_e1002',
    'width': 800,
    'height': 480,
    'rotate': 90,
}


@pytest.mark.asyncio
async def test_adopt_by_code_takes_a_pis_admin_login_and_stores_it(async_client, db, redis):
    fake = FakeFrame(LINUX_INFO)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body(code='123 456'))
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    # The code went to the frame as digits, and the login it handed over is
    # what the password flow then used and the row keeps.
    assert ('POST', 8787, '/api/adopt', {'code': '123456'}) in fake.calls
    assert fake.logins and all(login == {'username': 'admin', 'password': 'minted-pass'} for login in fake.logins)
    assert frame.frame_admin_auth == {'enabled': True, 'user': 'admin', 'pass': 'minted-pass'}
    assert frame.mode == 'rpios'
    assert frame.frame_port == 8787
    assert frame.name == 'Kitchen frame'
    assert fake.posted[0]['server_host'] == '10.0.0.5'
    assert fake.posted[0]['server_api_key'] == frame.server_api_key


@pytest.mark.asyncio
async def test_adopt_by_code_creates_an_embedded_row_and_tells_the_board_this_backend(async_client, db, redis):
    claims = []

    def claim(body):
        claims.append(body)
        return 200, {'ok': True}

    # Nobody typed a port: 8787 does not answer, the ESP32 does on 80.
    fake = FakeFrame(ESP32_INFO, ports=(80,), claim=claim)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body(name='Hallway'))
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    assert [(m, p, path) for m, p, path, _ in fake.calls] == [
        ('GET', 8787, '/api/adopt'),
        ('GET', 80, '/api/adopt'),
        ('POST', 80, '/api/adopt'),
        # Back up on the new key: what it holds (nothing, here).
        ('GET', 80, f'/api/frames/{frame.id}/scenes'),
    ]
    assert frame.mode == 'embedded'
    assert frame.name == 'Hallway'
    assert frame.frame_host == '10.0.0.42'
    assert frame.frame_port == 80
    assert frame.embedded['platform'] == 'esp32-s3'
    assert frame.embedded['hardwarePreset'] == 'seeed_reterminal_e1002'
    assert frame.device_config['hardwarePreset'] == 'seeed_reterminal_e1002'
    assert frame.device == 'waveshare.EPD_7in3e'
    assert (frame.width, frame.height, frame.rotate) == (800, 480, 90)
    assert frame.server_host == '10.0.0.5' and frame.server_port == 8989
    assert frame.server_api_key
    assert frame.https_proxy['enable'] is False
    # No admin login was asked for or used.
    assert fake.logins == []
    assert claims == [{
        'code': '123456',
        'backend': 'http://10.0.0.5:8989',
        'apiKey': frame.server_api_key,
        'frameId': frame.id,
        # It sends this backend its logs, as one provisioned over USB does.
        'sendLogs': True,
    }]
    # The baseline a finished USB provisioning records, on the board's release.
    assert frame.last_successful_deploy['frameos_version'] == '2026.11.11'
    assert frame.status == 'starting'


@pytest.mark.asyncio
async def test_adopt_by_code_embedded_without_preset_or_size_takes_the_panel_and_leaves_the_size(async_client, db, redis):
    info = {**ESP32_INFO, 'hardwarePreset': '', 'panel': 'EPD_7in5_V2', 'name': 'FrameOS frame'}
    info.pop('width')
    info.pop('height')
    fake = FakeFrame(info, ports=(80,), claim=lambda body: (200, {'ok': True}))
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body(frame_host='10.0.0.43:80'))
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])
    # A typed port is the only one tried.
    assert [p for _, p, _, _ in fake.calls] == [80, 80, 80]
    assert frame.device == 'waveshare.EPD_7in5_V2'
    assert frame.width is None and frame.height is None
    assert 'hardwarePreset' not in frame.embedded
    # The image's placeholder name gives way to the address.
    assert frame.name == '10.0.0.43'


BOARD_SCENES = [
    {'id': 'clock', 'name': 'Clock', 'default': True, 'nodes': [], 'edges': [],
     'settings': {'execution': 'interpreted'}},
    {'id': 'pixel toys', 'name': 'Pixel toys', 'nodes': [], 'edges': [], 'settings': {'execution': 'interpreted'}},
    {'id': 'layout-reterminal-sticky', 'name': 'Sticky', 'nodes': [], 'edges': [],
     'settings': {'execution': 'interpreted', 'isLayout': True}},
]


@pytest.mark.asyncio
async def test_adopt_by_code_reads_the_boards_own_scenes_into_the_row_and_the_baseline(
    async_client, no_auth_client, db, redis
):
    # The board restarts after the claim: the first reads find nobody.
    fake = FakeFrame(ESP32_INFO, ports=(80,), claim=lambda body: (200, {'ok': True}),
                     board_scenes=BOARD_SCENES, scene_reads_refused=2)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 200, response.text
    assert [scene['id'] for scene in response.json()['frame']['scenes']] == ['clock', 'pixel toys', 'layout-reterminal-sticky']
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    assert [scene['id'] for scene in frame.scenes] == ['clock', 'pixel toys', 'layout-reterminal-sticky']
    assert frame.scenes[0]['default'] is True
    assert ('GET', 80, f'/api/frames/{frame.id}/scenes/pixel%20toys', None) in fake.calls
    # What it holds is what was deployed to it: nothing pending, nothing marked.
    assert frame.last_successful_deploy['scenes'] == frame.scenes
    assert 'sceneImport' not in frame.embedded
    assert 'sceneImport' not in frame.last_successful_deploy['embedded']
    # Its pull is answered with them, so a deploy gives it back what it had.
    pulled = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/scenes', headers={'Authorization': f'Bearer {frame.server_api_key}'}
    )
    assert pulled.status_code == 200
    assert [scene['id'] for scene in pulled.json()] == ['clock', 'pixel toys', 'layout-reterminal-sticky']


def _scene_using(scene_id, name, groups, *, store=False):
    """A scene whose one app declares the settings `groups`; from the store
    when `store` (origin.storeSceneId, as the store stamps every scene)."""
    scene = {
        'id': scene_id,
        'name': name,
        'nodes': [{'id': 'n1', 'type': 'app', 'data': {'keyword': 'keyApp'}}],
        'edges': [],
        'apps': {'keyApp': {'sources': {
            'app.ts': 'export function get() {}',
            'config.json': json.dumps({'name': 'Key app', 'settings': groups}),
        }}},
        'settings': {'execution': 'interpreted'},
    }
    if store:
        scene['origin'] = {'storeSceneId': '0b1f6a4e-2c3d-4e5f-8a9b-0c1d2e3f4a5b', 'version': 3}
    return scene


@pytest.mark.asyncio
async def test_an_adopted_boards_scenes_get_the_keys_they_use(async_client, no_auth_client, db, redis, project):
    """A store scene the board installed by itself said "Add an OpenAI API
    key" with the key on this backend: an import granted nothing."""
    db.add_all([
        Settings(project_id=project.id, key='openAI', value={'apiKey': 'sk-backend'}),
        Settings(project_id=project.id, key='unsplash', value={'accessKey': 'unsplash-backend'}),
        Settings(project_id=project.id, key='buildHost', value={'host': 'build.local'}),
    ])
    db.commit()
    board_scenes = [
        _scene_using('word', 'Word of the day', ['openAI', 'buildHost'], store=True),
        _scene_using('photos', 'Photos', ['unsplash']),
    ]
    fake = FakeFrame(ESP32_INFO, ports=(80,), claim=lambda body: (200, {'ok': True}), board_scenes=board_scenes)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    # Bound as installing it from the store binds it (that scene's own keys,
    # docs/service-keys.md); the owner's own scene needs no binding, and
    # nothing but a service is bound.
    assert not frame.service_setting_groups
    assert {scene['id']: scene.get('keys') for scene in frame.scenes} == {'word': {'openAI': 'default'}, 'photos': None}
    pulled = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers={'Authorization': f'Bearer {frame.server_api_key}'}
    )
    assert pulled.status_code == 200, pulled.text
    keys = pulled.json()
    assert keys['openAI'] == {'apiKey': 'sk-backend'}
    assert keys['unsplash'] == {'accessKey': 'unsplash-backend'}
    assert 'buildHost' not in keys
    # The board pulls them by itself: the baseline says it has them, so
    # nothing is pending.
    fingerprints = frame.last_successful_deploy['settings_fingerprints']
    assert set(fingerprints) == {'openAI', 'unsplash', 'serviceKeys'}
    assert fingerprints == frame.to_dict()['settings_fingerprints']


@pytest.mark.asyncio
async def test_an_adopted_pi_gets_the_keys_its_scenes_use(async_client, db, redis, project):
    db.add(Settings(project_id=project.id, key='openAI', value={'apiKey': 'sk-backend'}))
    db.commit()
    device = {**_linux_device_payload(), 'scenes': [_scene_using('word', 'Word of the day', ['openAI'], store=True)]}
    fake = FakeFrame(LINUX_INFO, linux_payload=device)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    assert frame.scenes[0]['keys'] == {'openAI': 'default'}
    # Written as the admin-API deploy writes them, before the write-back
    # reloads the runtime; the route merges, so the frame's other keys stay.
    assert len(fake.settings_posted) == 1
    posted = fake.settings_posted[0]
    assert posted['openAI'] == {'apiKey': 'sk-backend'}
    assert posted['serviceKeys']['scenes'] == {'word': {'openAI': 'openAI'}}
    assert set(posted) == {'openAI', 'serviceKeys'}
    writes = [path for method, _, path, _ in fake.calls if method == 'POST' and path != '/api/admin/login']
    assert writes.index('/api/settings') < writes.index('/api/frames/1')
    fingerprints = frame.last_successful_deploy['settings_fingerprints']
    assert set(fingerprints) == {'openAI', 'serviceKeys'}
    assert fingerprints == frame.to_dict()['settings_fingerprints']


@pytest.mark.asyncio
async def test_an_adopted_pi_whose_keys_could_not_be_written_is_offered_them(async_client, db, redis, project):
    db.add(Settings(project_id=project.id, key='openAI', value={'apiKey': 'sk-backend'}))
    db.commit()
    device = {**_linux_device_payload(), 'scenes': [_scene_using('word', 'Word of the day', ['openAI'], store=True)]}
    fake = FakeFrame(LINUX_INFO, linux_payload=device, settings_status=500)
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()['frame']['id'])

    # Adopted all the same; the workspace shows the keys as a change to deploy.
    assert frame.last_successful_deploy['settings_fingerprints'] == {}
    assert set(frame.to_dict()['settings_fingerprints']) == {'openAI', 'serviceKeys'}
    lines = [log.line for log in db.query(Log).filter_by(frame_id=frame.id, type='stderr')]
    assert any('service keys could not be written' in line for line in lines), lines


@pytest.mark.asyncio
async def test_adopted_board_is_sent_no_scenes_until_its_own_are_read(async_client, no_auth_client, db, redis):
    # It does not come back while the adoption waits.
    fake = FakeFrame(ESP32_INFO, ports=(80,), claim=lambda body: (200, {'ok': True}),
                     board_scenes=BOARD_SCENES, scene_reads_refused=10**6)
    with _patched(fake), patch('app.utils.frame_http._fetch_frame_http_bytes', new=AsyncMock(side_effect=fake.fetch)):
        response = await async_client.post('/api/frames/adopt', json=_body())
        assert response.status_code == 200, response.text
        db.expire_all()
        frame = db.get(Frame, response.json()['frame']['id'])
        assert frame.scenes == []
        assert frame.embedded['sceneImport'] == 'pending'
        device = {'Authorization': f'Bearer {frame.server_api_key}'}

        # Its pull is refused (it keeps what it holds), and tries the import.
        pulled = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=device)
        assert pulled.status_code == 503
        await _background_imports_done()

        # A settings save from a form loaded before neither drops the mark nor
        # stops it; a scene saved here meanwhile stays.
        saved = await async_client.post(f'/api/frames/{frame.id}', json={'embedded': {'platform': 'esp32-s3'}})
        assert saved.status_code == 200, saved.text
        db.expire_all()
        frame = db.get(Frame, frame.id)
        assert frame.embedded['sceneImport'] == 'pending'
        frame.scenes = [{'id': 'mine', 'name': 'Mine', 'nodes': [], 'edges': []},
                        {'id': 'clock', 'name': 'My clock', 'nodes': [], 'edges': []}]
        db.commit()

        # A minute on, the board is up and checks in: its scenes are read.
        fake.scene_reads_refused = 0
        await redis.delete(embedded_scene_import.IMPORT_CLAIM_KEY.format(frame.id))
        hello = await no_auth_client.post(f'/api/frames/{frame.id}/embedded/commands', json={}, headers=device)
        assert hello.status_code == 200, hello.text
        await _background_imports_done()

    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert 'sceneImport' not in frame.embedded
    assert [scene['id'] for scene in frame.scenes] == ['mine', 'clock', 'pixel toys', 'layout-reterminal-sticky']
    assert frame.scenes[1]['name'] == 'My clock'
    # The baseline is what the board holds: "mine" and this clock are the changes to deploy.
    assert [scene['id'] for scene in frame.last_successful_deploy['scenes']] == [
        'clock', 'pixel toys', 'layout-reterminal-sticky'
    ]
    pulled = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=device)
    assert pulled.status_code == 200


@pytest.mark.asyncio
async def test_adopt_by_code_deletes_the_embedded_row_when_the_board_refuses(async_client, db, redis):
    frames_before = db.query(Frame).count()
    for token, status, fragment in (
        ('invalid_code', 403, 'not the code the frame shows'),
        ('code_expired', 410, 'code ran out'),
        ('too_many_attempts', 403, 'Too many wrong codes'),
        ('managed', 409, 'already managed'),
        ('rate_limited', 429, 'Wait a minute'),
        ('invalid_request', 400, 'backend is not an http(s) origin'),
    ):
        fake = FakeFrame(
            ESP32_INFO,
            ports=(80,),
            claim=lambda body, t=token, s=status: (s, {'error': t, 'detail': 'backend is not an http(s) origin'}),
        )
        with _patched(fake):
            response = await async_client.post('/api/frames/adopt', json=_body())
        assert response.status_code == 400, (token, response.text)
        assert fragment in response.json()['detail'], (token, response.json()['detail'])
        assert db.query(Frame).count() == frames_before, token


@pytest.mark.asyncio
async def test_adopt_by_code_wrong_code_on_a_pi_creates_nothing(async_client, db, redis):
    fake = FakeFrame(LINUX_INFO, claim=lambda body: (403, {'error': 'invalid_code', 'detail': 'Wrong code'}))
    frames_before = db.query(Frame).count()
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body(code='654321'))
    assert response.status_code == 400
    assert 'not the code the frame shows' in response.json()['detail']
    assert fake.logins == []
    assert db.query(Frame).count() == frames_before


@pytest.mark.asyncio
async def test_adopt_by_code_when_no_code_is_showing(async_client, db, redis):
    fake = FakeFrame({'adopting': False})
    frames_before = db.query(Frame).count()
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 400
    assert 'No adoption code is showing on the frame' in response.json()['detail']
    assert 'Link to backend' in response.json()['detail']
    # Nothing was posted, so no try was spent.
    assert [m for m, _, _, _ in fake.calls] == ['GET']
    assert db.query(Frame).count() == frames_before


@pytest.mark.asyncio
async def test_adopt_by_code_refuses_a_malformed_code_and_reports_an_unreachable_frame(async_client, db, redis):
    fake = FakeFrame(LINUX_INFO, ports=())
    with _patched(fake):
        response = await async_client.post('/api/frames/adopt', json=_body(code='12345'))
        assert response.status_code == 400
        assert 'six digits' in response.json()['detail']
        assert fake.calls == []

        response = await async_client.post('/api/frames/adopt', json=_body())
    assert response.status_code == 502
    detail = response.json()['detail']
    assert detail.startswith('Could not reach the frame at 10.0.0.42:8787')
    assert '10.0.0.42:80' in detail


@pytest.mark.asyncio
async def test_adopt_without_a_code_still_needs_the_admin_login(async_client, db, redis):
    response = await async_client.post('/api/frames/adopt', json={
        'frame_host': '10.0.0.42', 'server_host': '10.0.0.5:8989',
    })
    assert response.status_code == 400
    assert 'admin username and password are required' in response.json()['detail']


def test_embedded_device_for_panel_reverses_the_panel_mapping():
    for device in ('waveshare.EPD_7in5_V2', 'oled.ssd1306_72x40', 'lcd.st7701s_480x480'):
        assert embedded_device_for_panel(embedded_panel_for_device(device)) == device
    assert embedded_device_for_panel('none') is None
    assert embedded_device_for_panel('EPD_does_not_exist') is None


@pytest.mark.asyncio
async def test_a_board_scene_read_that_can_never_succeed_holds_nothing_back():
    """A scene the board lists and cannot serve is skipped, and a firmware
    with no scene list ends the import: neither may keep the marker, which
    holds every scene pull (every deploy) back, for good."""
    frame = Frame(id=9, name="board")
    answers = {
        "/api/frames/9/scenes": (200, json.dumps({"scenes": [{"id": "a"}, {"id": "gone"}]}).encode()),
        "/api/frames/9/scenes/a": (200, json.dumps({"id": "a", "nodes": []}).encode()),
        "/api/frames/9/scenes/gone": (404, b"{}"),
    }

    async def fetch(_frame, _redis, *, path, attempts=None):
        status, body = answers[path]
        return status, body, {}

    scenes = await embedded_scene_import.read_board_scenes(frame, None, fetch)
    assert [scene["id"] for scene in scenes] == ["a"]

    # A board that is away is tried again, never skipped.
    answers["/api/frames/9/scenes/gone"] = (503, b"")
    with pytest.raises(embedded_scene_import.SceneImportError):
        await embedded_scene_import.read_board_scenes(frame, None, fetch)

    answers["/api/frames/9/scenes"] = (404, b"")
    with pytest.raises(embedded_scene_import.SceneListMissing):
        await embedded_scene_import.read_board_scenes(frame, None, fetch)
