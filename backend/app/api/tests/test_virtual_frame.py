import pytest

from app.models.frame import Frame
from app.tasks.embedded_firmware import ensure_embedded_frame_defaults


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
