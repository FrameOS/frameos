import pytest

from app.models.frame import Frame
from app.tasks.embedded_firmware import ensure_embedded_frame_defaults


@pytest.fixture
def virtual_assets_dir(tmp_path, monkeypatch):
    root = tmp_path / "virtual_assets"
    monkeypatch.setenv("FRAMEOS_VIRTUAL_ASSETS_DIR", str(root))
    return root


async def create_virtual_frame(async_client, db) -> Frame:
    response = await async_client.post('/api/frames/new', json={
        'name': 'Virtual Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'virtual',
    })
    assert response.status_code == 200, response.text
    frame = db.get(Frame, response.json()['frame']['id'])
    ensure_embedded_frame_defaults(frame, 'virtual')
    frame.width = 320
    frame.height = 240
    db.add(frame)
    db.commit()
    assert frame.server_api_key
    return frame


@pytest.mark.asyncio
async def test_virtual_image_requires_token(async_client, no_auth_client, db):
    frame = await create_virtual_frame(async_client, db)
    response = await no_auth_client.get(f'/api/frames/{frame.id}/virtual/image')
    assert response.status_code == 401
    response = await no_auth_client.get(f'/api/frames/{frame.id}/virtual/image?k=wrong')
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_virtual_image_rejected_for_hardware_frames(async_client, no_auth_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
    })
    frame = db.get(Frame, response.json()['frame']['id'])
    ensure_embedded_frame_defaults(frame)
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/virtual/image?k=any-token')
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_virtual_image_serves_png_at_configured_size(async_client, no_auth_client, db):
    import io

    from PIL import Image

    frame = await create_virtual_frame(async_client, db)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/virtual/image?k={frame.device_config["viewToken"]}')
    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == 'image/png'
    assert response.headers['cache-control'] == 'no-store'
    image = Image.open(io.BytesIO(response.content))
    assert image.size == (320, 240)


@pytest.mark.asyncio
async def test_virtual_image_bw_color_mode(async_client, no_auth_client, db):
    import io

    from PIL import Image

    frame = await create_virtual_frame(async_client, db)
    frame.device_config = {**(frame.device_config or {}), 'colorMode': 'bw'}
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/virtual/image?k={frame.device_config["viewToken"]}')
    assert response.status_code == 200
    image = Image.open(io.BytesIO(response.content)).convert('RGB')
    colors = image.getcolors(maxcolors=16)
    assert colors is not None  # quantized to a handful of colors
    for _count, color in colors:
        assert color in ((0, 0, 0), (255, 255, 255))


@pytest.mark.asyncio
async def test_virtual_page_embeds_image_and_interval(async_client, no_auth_client, db):
    frame = await create_virtual_frame(async_client, db)
    frame.interval = 60
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/virtual/page?k={frame.device_config["viewToken"]}')
    assert response.status_code == 200
    body = response.text
    assert f'/api/frames/{frame.id}/virtual/image?k={frame.device_config["viewToken"]}' in body
    assert '60000' in body  # refresh interval in ms


@pytest.mark.asyncio
async def test_virtual_frame_defaults(async_client, db):
    frame = await create_virtual_frame(async_client, db)
    assert frame.device == 'virtual'
    assert frame.embedded['platform'] == 'virtual'


@pytest.mark.asyncio
async def test_virtual_deploy_renders_and_succeeds(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    response = await async_client.post(f'/api/frames/{frame.id}/deploy')
    assert response.status_code == 200, response.text
    assert response.json()['message'] == 'Success'


@pytest.mark.asyncio
async def test_virtual_set_current_scene_event(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [
        {'id': 'scene-a', 'name': 'A', 'nodes': [], 'edges': []},
        {'id': 'scene-b', 'name': 'B', 'nodes': [], 'edges': []},
    ]
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/event/setCurrentScene',
        json={'sceneId': 'scene-b'},
        headers={'content-type': 'application/json'})
    assert response.status_code == 200, response.text
    assert await redis.get(f'frame:{frame.id}:active_scene') in (b'scene-b', 'scene-b')


@pytest.mark.asyncio
async def test_virtual_render_event(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    response = await async_client.post(f'/api/frames/{frame.id}/event/render')
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_virtual_activation_persists_scene_image(async_client, db, redis):
    from app.models.scene_image import SceneImage

    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [
        {'id': 'scene-a', 'name': 'A', 'nodes': [], 'edges': []},
        {'id': 'scene-b', 'name': 'B', 'nodes': [], 'edges': []},
    ]
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/event/setCurrentScene',
        json={'sceneId': 'scene-b'},
        headers={'content-type': 'application/json'})
    assert response.status_code == 200, response.text

    row = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='scene-b').first()
    assert row is not None, "SceneImage row should persist for the activated scene"
    assert row.image and row.width == 320

    # And the UI's reload path serves it.
    response = await async_client.get(f'/api/frames/{frame.id}/scene_images/scene-b')
    assert response.status_code == 200, response.text
    assert response.headers['content-type'].startswith('image/')


# ------------------------------------------------------------------- assets


@pytest.mark.asyncio
async def test_virtual_assets_upload_list_download(async_client, db, redis, virtual_assets_dir):
    frame = await create_virtual_frame(async_client, db)

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        data={'path': 'photos'},
        files={'file': ('hello.txt', b'hello world')})
    assert response.status_code == 200, response.text
    assert response.json()['path'] == 'photos/hello.txt'
    assert (virtual_assets_dir / f'frame_{frame.id}' / 'photos' / 'hello.txt').read_bytes() == b'hello world'

    response = await async_client.get(f'/api/frames/{frame.id}/assets')
    assert response.status_code == 200, response.text
    assets = response.json()['assets']
    paths = {a['path']: a for a in assets}
    assert '/srv/assets/photos' in paths and paths['/srv/assets/photos']['is_dir']
    entry = paths['/srv/assets/photos/hello.txt']
    assert entry['size'] == len(b'hello world')
    assert not entry['is_dir']

    response = await async_client.get(
        f'/api/projects/{async_client.project_id}/frames/{frame.id}/asset'
        '?path=photos/hello.txt&mode=download')
    assert response.status_code == 200, response.text
    assert response.content == b'hello world'


@pytest.mark.asyncio
async def test_virtual_assets_mkdir_rename_delete(async_client, db, redis, virtual_assets_dir):
    frame = await create_virtual_frame(async_client, db)

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/mkdir', data={'path': 'a/b'})
    assert response.status_code == 200, response.text
    assert (virtual_assets_dir / f'frame_{frame.id}' / 'a' / 'b').is_dir()

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        data={'path': 'a/b'},
        files={'file': ('one.txt', b'one')})
    assert response.status_code == 200, response.text

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/rename',
        data={'src': 'a/b/one.txt', 'dst': 'a/two.txt'})
    assert response.status_code == 200, response.text
    root = virtual_assets_dir / f'frame_{frame.id}'
    assert not (root / 'a' / 'b' / 'one.txt').exists()
    assert (root / 'a' / 'two.txt').read_bytes() == b'one'

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/delete', data={'path': 'a'})
    assert response.status_code == 200, response.text
    assert not (root / 'a').exists()

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/delete', data={'path': 'a/two.txt'})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_virtual_assets_missing_download_404(async_client, db, redis, virtual_assets_dir):
    frame = await create_virtual_frame(async_client, db)
    response = await async_client.get(
        f'/api/projects/{async_client.project_id}/frames/{frame.id}/asset'
        '?path=nope.txt&mode=download')
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_virtual_assets_quota(async_client, db, redis, virtual_assets_dir):
    frame = await create_virtual_frame(async_client, db)
    # ~1 KB quota via the per-frame override.
    frame.device_config = {**(frame.device_config or {}), 'assetsQuotaMb': 0.001}
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        files={'file': ('big.bin', b'x' * 2000)})
    assert response.status_code == 507, response.text
    assert 'quota' in response.json()['detail'].lower()

    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        files={'file': ('small.bin', b'x' * 600)})
    assert response.status_code == 200, response.text

    # The second small file pushes the total over the quota.
    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        files={'file': ('small2.bin', b'x' * 600)})
    assert response.status_code == 507

    # Replacing the existing file does not double-count its old bytes.
    response = await async_client.post(
        f'/api/frames/{frame.id}/assets/upload',
        files={'file': ('small.bin', b'y' * 700)})
    assert response.status_code == 200, response.text


# -------------------------------------------------------------------- state


def _stateful_scene(scene_id='scene-a'):
    return {
        'id': scene_id,
        'name': 'Stateful',
        'nodes': [],
        'edges': [],
        'fields': [
            {'name': 'word', 'type': 'string', 'access': 'public', 'value': 'hi'},
            {'name': 'config', 'type': 'json', 'access': 'public'},
            {'name': 'secret', 'type': 'string', 'access': 'private'},
        ],
    }


@pytest.mark.asyncio
async def test_virtual_set_scene_state_roundtrip(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [_stateful_scene()]
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/event/setSceneState',
        json={'sceneId': 'scene-a', 'render': True,
              'state': {'word': 'hello', 'secret': 'nope', 'unknown': 'dropped'}},
        headers={'content-type': 'application/json'})
    assert response.status_code == 200, response.text

    response = await async_client.get(f'/api/frames/{frame.id}/states')
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload['sceneId'] == 'scene-a'
    # Only declared public fields survive the filter.
    assert payload['states']['scene-a'] == {'word': 'hello'}

    response = await async_client.get(f'/api/frames/{frame.id}/state')
    assert response.status_code == 200, response.text
    assert response.json() == {'sceneId': 'scene-a', 'state': {'word': 'hello'}}


@pytest.mark.asyncio
async def test_virtual_state_merges_and_parses_json_fields(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [_stateful_scene()]
    db.add(frame)
    db.commit()

    for state in ({'word': 'first'}, {'config': '{"a": 1}'}):
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setSceneState',
            json={'sceneId': 'scene-a', 'state': state},
            headers={'content-type': 'application/json'})
        assert response.status_code == 200, response.text

    response = await async_client.get(f'/api/frames/{frame.id}/states')
    states = response.json()['states']
    # Merged across events; json-typed strings parsed like the device does.
    assert states['scene-a'] == {'word': 'first', 'config': {'a': 1}}


@pytest.mark.asyncio
async def test_virtual_set_current_scene_applies_state(async_client, db, redis):
    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [_stateful_scene('scene-a'), _stateful_scene('scene-b')]
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/event/setCurrentScene',
        json={'sceneId': 'scene-b', 'state': {'word': 'switched'}},
        headers={'content-type': 'application/json'})
    assert response.status_code == 200, response.text

    response = await async_client.get(f'/api/frames/{frame.id}/states')
    payload = response.json()
    assert payload['sceneId'] == 'scene-b'
    assert payload['states']['scene-b'] == {'word': 'switched'}


@pytest.mark.asyncio
async def test_virtual_state_rejects_oversized_payload(async_client, db, redis):
    from app.api.virtual_frame import VIRTUAL_STATE_QUOTA_BYTES

    frame = await create_virtual_frame(async_client, db)
    frame.scenes = [_stateful_scene()]
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f'/api/frames/{frame.id}/event/setSceneState',
        json={'sceneId': 'scene-a',
              'state': {'word': 'x' * (VIRTUAL_STATE_QUOTA_BYTES + 1)}},
        headers={'content-type': 'application/json'})
    assert response.status_code == 413
