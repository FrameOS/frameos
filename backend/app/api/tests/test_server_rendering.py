"""Rendering on the server (docs/server-rendering.md), on the self-hosted
backend: the render pull's ETag, which scene it draws, and the picture drawn
before a sleeping frame wakes."""

import json
import os
import shutil
import time
from datetime import datetime, timedelta

import pytest
from PIL import Image

from app.api.embedded_device import prerender_thin_client
from app.api.virtual_frame import apply_virtual_scene_state, get_virtual_scene_states
from app.models.frame import Frame
from app.models.log import process_log
from app.tasks.embedded_firmware import is_thin_client_frame
from app.utils import server_render
from app.utils.embedded_render import render_scene
from app.utils.frame_commands import enqueue_frame_command
from app.utils.server_render import (
    PRERENDER_MAX_SKEW_SECONDS,
    epoch_ms,
    etag_matches,
    fosb_etag,
    prerender_lead_seconds,
    prerender_usable,
)

from .test_embedded_device import auth, device_frame


SCENES = [
    {
        'id': 'clock',
        'name': 'Clock',
        'nodes': [],
        'edges': [],
        'fields': [{'name': 'label', 'type': 'string', 'value': 'hi', 'access': 'public'}],
    },
    {'id': 'photos', 'name': 'Photos', 'nodes': [], 'edges': [], 'fields': []},
]


def recording_renderer(calls: list, rgba_pixel=(0, 0, 0, 255), state=None):
    """Stands in for the node + wasm render: records each call's keyword
    arguments and answers one flat-colour frame and the state it ended with."""
    async def fake_render(frame_arg, width, height, **kwargs):
        calls.append(kwargs)
        return bytes(rgba_pixel) * (width * height), state, None

    return fake_render


async def refusing_render(frame_arg, width, height, **kwargs):
    raise AssertionError('the pull rendered although a kept picture fit')


async def server_rendered_frame(async_client, db, **device_config) -> Frame:
    """An ESP32-S3 set to render on the server, with two scenes."""
    frame = await device_frame(async_client, db)
    frame.device_config = {**(frame.device_config or {}), 'renderMode': 'remote', **device_config}
    frame.scenes = SCENES
    db.add(frame)
    db.commit()
    assert is_thin_client_frame(frame)
    return frame


def asleep_until(db, frame: Frame, seconds: float) -> int:
    """Put the frame to sleep with its next render `seconds` from now; the
    render time in epoch milliseconds."""
    wake = datetime.utcnow() + timedelta(seconds=seconds)
    frame.next_wake_at = wake
    frame.next_render_at = wake
    db.add(frame)
    db.commit()
    return epoch_ms(wake)


# ------------------------------------------------------------------ ETag


@pytest.mark.asyncio
async def test_the_pull_carries_an_etag_and_answers_304_for_the_picture_shown(
    async_client, no_auth_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer([]))
    url = f'/api/frames/{frame.id}/embedded/render'

    first = await no_auth_client.get(url, headers=auth(frame))
    assert first.status_code == 200, first.text
    etag = first.headers['etag']
    assert etag == fosb_etag(first.content)
    assert len(etag) == 34 and etag.startswith('"') and etag.endswith('"')
    assert first.headers['cache-control'] == 'no-store'

    same = await no_auth_client.get(url, headers={**auth(frame), 'If-None-Match': etag})
    assert same.status_code == 304
    assert same.content == b''
    assert same.headers['etag'] == etag

    # A board showing something else gets the bitmap.
    other = await no_auth_client.get(url, headers={**auth(frame), 'If-None-Match': '"0123456789abcdef0123456789abcdef"'})
    assert other.status_code == 200
    assert other.content == first.content


@pytest.mark.asyncio
async def test_the_diagnostic_card_is_answered_304_too(async_client, no_auth_client, db, redis, monkeypatch):
    frame = await device_frame(async_client, db)  # no scenes: the card

    def card(_frame, width, height):
        return Image.new('RGB', (width, height), (255, 255, 255))

    monkeypatch.setattr('app.api.embedded_device.embedded_diagnostic_image', card)
    url = f'/api/frames/{frame.id}/embedded/render'
    first = await no_auth_client.get(url, headers=auth(frame))
    assert first.status_code == 200
    again = await no_auth_client.get(url, headers={**auth(frame), 'If-None-Match': first.headers['etag']})
    assert again.status_code == 304


def test_etag_matching_reads_weak_lists_and_star():
    etag = '"abc"'
    assert etag_matches('"abc"', etag)
    assert etag_matches('W/"abc"', etag)
    assert etag_matches('"zzz", "abc"', etag)
    assert etag_matches('*', etag)
    assert not etag_matches('"abd"', etag)
    assert not etag_matches(None, etag)
    assert not etag_matches('', etag)


# ------------------------------------------------------------ which scene


@pytest.mark.asyncio
async def test_the_pull_draws_the_scene_the_board_is_on_and_remembers_it(
    async_client, no_auth_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', params={'scene': 'photos'}, headers=auth(frame))
    assert response.status_code == 200
    assert calls[-1]['scene_id'] == 'photos'
    assert await redis.get(f'frame:{frame.id}:active_scene') == b'photos'


@pytest.mark.asyncio
async def test_a_switch_the_board_has_not_taken_yet_is_the_backends(
    async_client, no_auth_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    # The workspace switched to Photos; the queued switch still waits for the
    # board, which pulls still saying it is on the clock.
    await redis.set(f'frame:{frame.id}:active_scene', 'photos')
    enqueue_frame_command(db, frame, 'set_current_scene', {'scene_id': 'photos'})
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', params={'scene': 'clock'}, headers=auth(frame))
    assert response.status_code == 200
    assert calls[-1]['scene_id'] == 'photos'
    assert await redis.get(f'frame:{frame.id}:active_scene') == b'photos'


@pytest.mark.asyncio
async def test_a_scene_the_frame_does_not_have_is_not_drawn(async_client, no_auth_client, db, redis, monkeypatch):
    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', params={'scene': 'gone'}, headers=auth(frame))
    assert response.status_code == 200
    assert calls[-1]['scene_id'] == 'clock'
    assert await redis.get(f'frame:{frame.id}:active_scene') == b'clock'


# -------------------------------------------------- drawn before the wake


@pytest.mark.asyncio
async def test_a_picture_drawn_before_the_wake_is_the_pulls_once(
    async_client, no_auth_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    as_of_ms = asleep_until(db, frame, 30)
    calls: list = []
    monkeypatch.setattr(
        'app.api.embedded_device.render_scene_rgba_and_state',
        recording_renderer(calls, state={'sceneId': 'clock', 'state': {'label': 'drawn ahead'}}),
    )

    assert await prerender_thin_client(db, redis, frame, as_of_ms) is True
    # Drawn as of the wake, the scene's clock set to it.
    assert calls[-1]['now_ms'] == as_of_ms
    assert calls[-1]['scene_id'] == 'clock'
    # Its state waits for the pull: nothing is the scene's until it is shown.
    assert 'clock' not in await get_virtual_scene_states(redis, frame)

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', refusing_render)
    url = f'/api/frames/{frame.id}/embedded/render'
    response = await no_auth_client.get(url, params={'scene': 'clock'}, headers=auth(frame))
    assert response.status_code == 200, response.text
    assert response.content[:4] == b'FOSB'
    assert (await get_virtual_scene_states(redis, frame))['clock'] == {'label': 'drawn ahead'}

    # Used once: the next pull renders.
    calls.clear()
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    again = await no_auth_client.get(url, params={'scene': 'clock'}, headers=auth(frame))
    assert again.status_code == 200
    assert len(calls) == 1
    assert 'now_ms' not in calls[0] or calls[0]['now_ms'] is None


@pytest.mark.asyncio
async def test_a_state_written_since_it_was_drawn_sends_the_pull_to_render(
    async_client, no_auth_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    as_of_ms = asleep_until(db, frame, 30)
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer([]))
    assert await prerender_thin_client(db, redis, frame, as_of_ms) is True

    # The workspace sets a field while the frame sleeps.
    await apply_virtual_scene_state(redis, frame, 'clock', {'label': 'new'})

    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', params={'scene': 'clock'}, headers=auth(frame))
    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0]['scene_states']['clock'] == {'label': 'new'}


@pytest.mark.asyncio
async def test_another_scene_or_a_held_event_sends_the_pull_to_render(
    async_client, no_auth_client, db, redis, monkeypatch
):
    from app.api.embedded_device import hold_thin_client_event

    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    url = f'/api/frames/{frame.id}/embedded/render'

    # The board took a key press while asleep and woke on another scene.
    as_of_ms = asleep_until(db, frame, 30)
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer([]))
    assert await prerender_thin_client(db, redis, frame, as_of_ms) is True
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    await no_auth_client.get(url, params={'scene': 'photos'}, headers=auth(frame))
    assert [call['scene_id'] for call in calls] == ['photos']

    # An event held since: the pull runs it, so it renders.
    await redis.set(f'frame:{frame.id}:active_scene', 'clock')
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer([]))
    assert await prerender_thin_client(db, redis, frame, as_of_ms) is True
    await hold_thin_client_event(redis, frame, 'next', {})
    calls.clear()
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    await no_auth_client.get(url, params={'scene': 'clock'}, headers=auth(frame))
    assert len(calls) == 1
    assert [event['name'] for event in calls[0]['control_events']] == ['next']


@pytest.mark.asyncio
async def test_nothing_is_drawn_ahead_for_a_frame_that_is_awake_or_has_an_event_waiting(
    async_client, db, redis, monkeypatch
):
    from app.api.embedded_device import hold_thin_client_event

    frame = await server_rendered_frame(async_client, db)
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    now_ms = int(time.time() * 1000)

    # Awake: no wake to draw for.
    assert await prerender_thin_client(db, redis, frame, now_ms + 30_000) is False
    # Asleep, but for another wake than the job's.
    as_of_ms = asleep_until(db, frame, 30)
    assert await prerender_thin_client(db, redis, frame, as_of_ms + 60_000) is False
    # An event waits: the pull at the wake must hear it.
    await hold_thin_client_event(redis, frame, 'next', {})
    assert await prerender_thin_client(db, redis, frame, as_of_ms) is False
    assert calls == []


@pytest.mark.asyncio
async def test_a_frame_that_renders_itself_is_not_drawn_ahead(async_client, db, redis, monkeypatch):
    frame = await device_frame(async_client, db)  # an S3 rendering locally
    frame.scenes = SCENES
    db.add(frame)
    db.commit()
    as_of_ms = asleep_until(db, frame, 30)
    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer(calls))
    assert await prerender_thin_client(db, redis, frame, as_of_ms) is False
    assert calls == []


def test_a_kept_picture_fits_only_its_fingerprint_revision_and_time():
    now_ms = 1_800_000_000_000
    record = {'asOfMs': now_ms, 'fingerprint': 'f', 'revision': 3}
    assert prerender_usable(record, fingerprint='f', revision=3, now_ms=now_ms)
    assert prerender_usable(record, fingerprint='f', revision=3, now_ms=now_ms + PRERENDER_MAX_SKEW_SECONDS * 1000)
    assert not prerender_usable(record, fingerprint='f', revision=3, now_ms=now_ms + PRERENDER_MAX_SKEW_SECONDS * 1000 + 1)
    assert not prerender_usable(record, fingerprint='f', revision=3, now_ms=now_ms - PRERENDER_MAX_SKEW_SECONDS * 1000 - 1)
    assert not prerender_usable(record, fingerprint='g', revision=3, now_ms=now_ms)
    assert not prerender_usable(record, fingerprint='f', revision=4, now_ms=now_ms)
    assert not prerender_usable({'fingerprint': 'f', 'revision': 3}, fingerprint='f', revision=3, now_ms=now_ms)


def test_the_lead_is_twice_the_last_render_plus_ten_seconds_within_bounds():
    assert prerender_lead_seconds(None) == 20
    assert prerender_lead_seconds(2_000) == 20
    assert prerender_lead_seconds(10_000) == 30
    assert prerender_lead_seconds(30_000) == 70
    assert prerender_lead_seconds(60_000) == 90


@pytest.mark.asyncio
async def test_a_sleep_line_queues_the_drawing_lead_seconds_before_the_render(
    async_client, db, redis, monkeypatch
):
    frame = await server_rendered_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:server_render_ms', 20_000)  # lead 50 s
    queued: list = []

    async def fake_enqueue(function, **kwargs):
        queued.append((function, kwargs))
        return object()

    monkeypatch.setattr(redis, 'enqueue_job', fake_enqueue, raising=False)
    render_at = int(time.time()) + 900
    await process_log(db, redis, frame, {'event': 'sleep', 'wakeInSeconds': 895, 'nextRenderAt': render_at})

    assert len(queued) == 1
    function, kwargs = queued[0]
    assert function == 'prerender_thin_client'
    assert kwargs['id'] == frame.id
    assert kwargs['as_of_ms'] == render_at * 1000
    assert kwargs['_job_id'] == f'prerender:{frame.id}:{render_at * 1000}'
    assert int(kwargs['_defer_until'].timestamp()) == render_at - 50


@pytest.mark.asyncio
async def test_a_sleep_line_from_a_frame_that_renders_itself_queues_nothing(async_client, db, redis, monkeypatch):
    frame = await device_frame(async_client, db)
    queued: list = []

    async def fake_enqueue(function, **kwargs):
        queued.append(function)
        return object()

    monkeypatch.setattr(redis, 'enqueue_job', fake_enqueue, raising=False)
    await process_log(db, redis, frame, {'event': 'sleep', 'wakeInSeconds': 900})
    assert queued == []


@pytest.mark.asyncio
async def test_a_sleep_shorter_than_the_lead_is_drawn_at_once(async_client, db, redis, monkeypatch):
    frame = await server_rendered_frame(async_client, db)
    queued: list = []

    async def fake_enqueue(function, **kwargs):
        queued.append(kwargs)
        return object()

    monkeypatch.setattr(redis, 'enqueue_job', fake_enqueue, raising=False)
    await process_log(db, redis, frame, {'event': 'sleep', 'wakeInSeconds': 10})
    assert len(queued) == 1
    assert '_defer_until' not in queued[0]


# ---------------------------------------------------------------- clock


@pytest.mark.asyncio
async def test_the_harness_tells_the_scene_the_time_it_is_drawn_for(tmp_path, monkeypatch):
    """The render harness shifts Date.now before the wasm module is made, so
    the runtime's clock (emscripten's `_emscripten_date_now`) reads `nowMs`.
    A stand-in module reports the clock it saw instead of rendering."""
    if shutil.which('node') is None:
        pytest.skip('node not available')
    (tmp_path / 'frameos.wasm').write_bytes(b'\0asm')
    (tmp_path / 'frameos.js').write_text(
        'export default async function createFrameOS() {\n'
        '  const seen = String(Date.now())\n'
        '  return { ccall: (name) => (name === "frameos_wasm_last_error" ? "clock " + seen : false) }\n'
        '}\n'
    )
    monkeypatch.setenv('FRAMEOS_WASM_DIR', str(tmp_path))
    frame = Frame(id=1, name='clock', scenes=[{'id': 's', 'name': 's', 'nodes': [], 'edges': []}])
    as_of_ms = 1_893_456_000_000  # 2030-01-01
    shifted = await render_scene(frame, 16, 16, now_ms=as_of_ms, timeout=20)
    assert shifted.rgba is None
    assert shifted.error is not None and shifted.error.startswith('init failed: clock ')
    seen = int(shifted.error.removeprefix('init failed: clock '))
    assert abs(seen - as_of_ms) < 10_000

    plain = await render_scene(frame, 16, 16, timeout=20)
    assert plain.error is not None
    assert abs(int(plain.error.removeprefix('init failed: clock ')) - time.time() * 1000) < 10_000


def test_the_scene_fetch_child_is_not_given_the_shifted_clock():
    """The scene's HTTP runs in a child Node (FETCH_CHILD_SCRIPT, spawned by
    process.execPath -e): a process of its own with the real clock, so TLS
    certificates are judged at the real time."""
    harness = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'tools', 'embedded_wasm_render.mjs')
    source = open(harness).read()
    shift = source.index('Date.now = () => realNow() + offsetMs')
    assert "spawnSync(process.execPath, ['-e', FETCH_CHILD_SCRIPT]" in source
    assert 'Date.now' not in source[source.index('const FETCH_CHILD_SCRIPT'):source.index('// Set once the request has been read')]
    assert shift > source.index('const request = JSON.parse(await readStdin())')
    assert shift < source.index('const Module = await createFrameOS(')


def test_the_lead_constants_match_the_spec():
    spec = open(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'docs', 'server-rendering.md')).read()
    assert 'at least 20 s and at most 90 s' in spec
    assert 'within 120 s of the time it was drawn for' in spec
    assert (server_render.PRERENDER_LEAD_MIN_SECONDS, server_render.PRERENDER_LEAD_MAX_SECONDS) == (20, 90)
    assert server_render.PRERENDER_MAX_SKEW_SECONDS == 120


# ------------------------------------------------------- an S3 board end to end


@pytest.mark.asyncio
async def test_a_xiao_ee02_rendered_on_the_server_pulls_its_13_inch_spectra_6_picture(
    async_client, no_auth_client, db, redis, monkeypatch
):
    """The board the switch was asked for (issue #706): an ESP32-S3 with the
    13.3" Spectra 6 panel. Its settings pull says remote, and its render pull
    is the panel's native 1200x1600 in the 4-bit Spectra 6 format."""
    import struct

    from app.api.embedded_device import embedded_frame_settings
    from app.tasks.embedded_firmware import FOS_PIXEL_4BPP_SPECTRA6, embedded_provisioning_plan

    response = await async_client.post('/api/frames/new', json={
        'name': 'EE02',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
        'device_config': {'hardwarePreset': 'seeed_xiao_ee02', 'renderMode': 'remote'},
    })
    assert response.status_code == 200, response.text
    frame = db.get(Frame, response.json()['frame']['id'])
    frame.scenes = SCENES
    db.add(frame)
    db.commit()
    assert is_thin_client_frame(frame)
    assert embedded_frame_settings(frame)['renderMode'] == 'remote'
    plan = embedded_provisioning_plan(frame)
    assert {'key': 'render_mode', 'value': 'remote'}.items() <= next(
        setting for setting in plan['settings'] if setting['key'] == 'render_mode').items()

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', recording_renderer([]))
    pulled = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert pulled.status_code == 200, pulled.text
    _version, pixel_format, width, height, _reserved = struct.unpack('<BBHHH', pulled.content[4:12])
    assert (pixel_format, width, height) == (FOS_PIXEL_4BPP_SPECTRA6, 1200, 1600)
    assert len(pulled.content) == 12 + 600 * 1600


# ----------------------------------------------------------- the scene's network


@pytest.mark.asyncio
async def test_a_physical_frame_rendered_here_reaches_its_lan_and_vpn_by_default(async_client, db):
    """docs/lan-access.md: a frame managed by a self-hosted backend has no
    local-network block, so moving its scene onto the backend must not take
    its NAS or VPN hosts away. The backend host's own addresses stay out."""
    from app.utils.embedded_render import scene_network_policy

    local = await device_frame(async_client, db)  # an S3 rendering itself
    assert scene_network_policy(local) == 'public'
    remote = await server_rendered_frame(async_client, db)
    assert scene_network_policy(remote) == 'private'
    remote.network = {'allowLocalNetworkAccess': True}
    assert scene_network_policy(remote) == 'all'
    remote.network = {'allowLocalNetworkAccess': False}
    assert scene_network_policy(remote) == 'public'

    response = await async_client.post('/api/frames/new', json={
        'name': 'C3', 'frame_host': '', 'server_host': 'localhost', 'mode': 'embedded', 'platform': 'esp32-c3',
    })
    c3 = db.get(Frame, response.json()['frame']['id'])
    assert is_thin_client_frame(c3)
    assert scene_network_policy(c3) == 'private'


@pytest.mark.asyncio
async def test_a_virtual_frame_keeps_the_opt_in_rule(async_client, db):
    from app.utils.embedded_render import scene_network_policy

    response = await async_client.post('/api/frames/new', json={
        'name': 'Virtual', 'frame_host': '', 'server_host': 'localhost', 'mode': 'embedded', 'platform': 'virtual',
    })
    assert response.status_code == 200, response.text
    virtual = db.get(Frame, response.json()['frame']['id'])
    from app.tasks.embedded_firmware import is_virtual_frame

    assert is_virtual_frame(virtual)
    assert not is_thin_client_frame(virtual)
    assert scene_network_policy(virtual) == 'public'
    virtual.network = {'allowLocalNetworkAccess': True}
    assert scene_network_policy(virtual) == 'all'


@pytest.mark.asyncio
async def test_the_render_request_carries_the_policy(async_client, db, tmp_path, monkeypatch):
    """What reaches the harness: `networkPolicy`, and `allowLocalNetwork` for
    an older harness (true only for `all`)."""
    import asyncio as asyncio_module

    from app.utils import embedded_render

    (tmp_path / 'frameos.wasm').write_bytes(b'\0asm')
    (tmp_path / 'frameos.js').write_text('export default async () => ({})\n')
    monkeypatch.setenv('FRAMEOS_WASM_DIR', str(tmp_path))
    sent: list = []

    class FakeProcess:
        returncode = 1

        async def communicate(self, data):
            sent.append(json.loads(data))
            return b'', b'embedded_wasm_render: stand-in\n'

    async def fake_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(asyncio_module, 'create_subprocess_exec', fake_exec)
    frame = await server_rendered_frame(async_client, db)
    await embedded_render.render_scene(frame, 16, 16)
    frame.network = {'allowLocalNetworkAccess': True}
    await embedded_render.render_scene(frame, 16, 16)
    assert [(r['networkPolicy'], r['allowLocalNetwork']) for r in sent] == [('private', False), ('all', True)]


# One request per case through the harness's own fetch child (its
# FETCH_CHILD_SCRIPT, taken out of the .mjs as the harness spawns it), to a
# literal address: a refusal is the guard's, anything else (refused, timed
# out, unreachable) means the guard let the connect happen.
_CHILD_RUNNER = r"""
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(process.argv[1], 'utf8');
const marker = 'const FETCH_CHILD_SCRIPT = `';
const start = source.indexOf(marker) + marker.length;
const end = source.indexOf('\n`\n', start);
const script = new Function('return `' + source.slice(start, end) + '`')();
const cases = JSON.parse(process.argv[2]);
const results = cases.map((request) => {
  const child = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(request), timeout: 10000 });
  try {
    return JSON.parse(child.stdout.toString('utf8'));
  } catch {
    return { status: -1, error: String(child.stderr) };
  }
});
process.stdout.write(JSON.stringify(results));
"""


def _fetch_outcomes(cases: list[tuple[dict, str]]) -> list[str]:
    harness = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'tools', 'embedded_wasm_render.mjs')
    requests = [
        {'method': 'GET', 'url': url, 'headers': {}, 'timeoutMs': 300, **policy} for policy, url in cases
    ]
    import subprocess

    done = subprocess.run(
        ['node', '-e', _CHILD_RUNNER, harness, json.dumps(requests)],
        capture_output=True, timeout=120, check=True,
    )
    outcomes = []
    for result in json.loads(done.stdout):
        error = result.get('error') or ''
        if error.startswith('Error: blocked: cloud metadata'):
            outcomes.append('metadata')
        elif error.startswith('Error: blocked: the backend'):
            outcomes.append('host')
        elif error.startswith('Error: blocked: local network access is off'):
            outcomes.append('local')
        else:
            outcomes.append('allowed')
    return outcomes


PRIVATE = {'networkPolicy': 'private'}
PUBLIC = {'networkPolicy': 'public'}
ALL = {'networkPolicy': 'all'}


def test_the_private_policy_reaches_lan_and_vpn_ranges_and_not_the_hosts_own():
    if shutil.which('node') is None:
        pytest.skip('node not available')
    cases = [
        (PRIVATE, 'http://10.20.30.40:9/', 'allowed'),
        (PRIVATE, 'http://172.16.5.4:9/', 'allowed'),
        (PRIVATE, 'http://192.168.1.20:9/', 'allowed'),
        (PRIVATE, 'http://100.101.102.103:9/', 'allowed'),  # Tailscale
        (PRIVATE, 'http://[fd7a:115c:a1e0::1]:9/', 'allowed'),  # Tailscale IPv6
        (PRIVATE, 'http://[::ffff:192.168.1.20]:9/', 'allowed'),
        (PRIVATE, 'http://127.0.0.1:9/', 'host'),
        (PRIVATE, 'http://[::1]:9/', 'host'),
        (PRIVATE, 'http://0.0.0.0:9/', 'host'),
        (PRIVATE, 'http://169.254.10.10:9/', 'host'),
        (PRIVATE, 'http://[fe80::1]:9/', 'host'),
        (PRIVATE, 'http://224.0.0.1:9/', 'host'),
        (PRIVATE, 'http://[::ffff:127.0.0.1]:9/', 'host'),
        (PRIVATE, 'http://169.254.169.254/latest/', 'metadata'),
        (PRIVATE, 'http://[fd00:ec2::254]/', 'metadata'),
        (PUBLIC, 'http://10.20.30.40:9/', 'local'),
        (PUBLIC, 'http://100.101.102.103:9/', 'local'),
        (PUBLIC, 'http://127.0.0.1:9/', 'local'),
        (ALL, 'http://10.20.30.40:9/', 'allowed'),
        (ALL, 'http://127.0.0.1:9/', 'allowed'),
        (ALL, 'http://169.254.169.254/', 'metadata'),
        # An older caller's word for the same.
        ({'allowLocalNetwork': True}, 'http://127.0.0.1:9/', 'allowed'),
        ({'allowLocalNetwork': False}, 'http://192.168.1.20:9/', 'local'),
        ({}, 'http://192.168.1.20:9/', 'local'),
    ]
    outcomes = _fetch_outcomes([(policy, url) for policy, url, _ in cases])
    assert [(url, policy, outcome) for (policy, url, _), outcome in zip(cases, outcomes)] == [
        (url, policy, expected) for policy, url, expected in cases
    ]


def test_a_name_that_resolves_to_the_hosts_own_address_is_refused_in_the_lookup():
    """Names go through the socket's own lookup: `localhost` answers with
    loopback, which a frame rendered here never reaches without the switch."""
    if shutil.which('node') is None:
        pytest.skip('node not available')
    assert _fetch_outcomes([(PRIVATE, 'http://localhost:9/'), (ALL, 'http://localhost:9/')]) == ['host', 'allowed']
