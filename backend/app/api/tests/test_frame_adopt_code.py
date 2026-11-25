"""Adoption by the code a frame draws on its panel: POST /api/frames/adopt
with `code` (docs/api-triality.md). The frame's side is faked: GET
/api/adopt says what it is, POST /api/adopt takes the code."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models.frame import Frame
from app.tasks.embedded_firmware import embedded_device_for_panel, embedded_panel_for_device


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
    """One frame on the network: the adoption routes, and for a Pi the admin
    API the password flow continues on. `ports` are where it answers."""

    def __init__(self, adopt_info, *, ports=(8787,), claim=None):
        self.adopt_info = adopt_info
        self.ports = set(ports)
        self.claim = claim or (lambda body: (200, {'username': 'admin', 'password': 'minted-pass'}))
        self.calls = []  # (method, port, path, body)
        self.logins = []
        self.posted = []

    async def fetch(self, frame_obj, redis_obj, *, path, method='GET', body=None, headers=None, **kwargs):
        port = frame_obj.frame_port
        parsed = json.loads(body) if body else None
        self.calls.append((method, port, path, parsed))
        if port not in self.ports:
            raise HTTPException(status_code=502, detail='All connection attempts failed')
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
        if path.startswith('/api/frames/1'):
            if method == 'POST':
                self.posted.append(parsed)
                return 200, b'{"message":"ok"}', {}
            return 200, json.dumps({'frame': _linux_device_payload()}).encode(), {}
        raise AssertionError(f'unexpected {method} {path}')


def _patched(fake):
    return patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=fake.fetch))


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
    assert [p for _, p, _, _ in fake.calls] == [80, 80]
    assert frame.device == 'waveshare.EPD_7in5_V2'
    assert frame.width is None and frame.height is None
    assert 'hardwarePreset' not in frame.embedded
    # The image's placeholder name gives way to the address.
    assert frame.name == '10.0.0.43'


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
