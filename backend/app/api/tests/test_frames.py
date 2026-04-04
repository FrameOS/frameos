import json
import io
import zipfile
from types import SimpleNamespace
import pytest
from unittest.mock import patch
import httpx

from app.api import frames as frames_api
from app.api.auth import get_current_user, get_current_user_from_request
from app.fastapi import app
from app.models import new_frame
from app.models.frame import Frame
from app.models.user import User
from app.redis import get_redis
from app.utils.cross_compile import TargetMetadata


def _write_prebuilt_target(target_root, target_slug: str, components: dict[str, dict[str, str]]) -> None:
    target_dir = target_root / target_slug
    target_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "target": target_slug,
        "components": components,
    }
    (target_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    for spec in components.values():
        component_dir = target_dir / spec["directory"]
        component_dir.mkdir(parents=True, exist_ok=True)
        artifact = spec.get("artifact")
        if artifact:
            (component_dir / artifact).write_bytes(spec.get("contents", "").encode("utf-8"))


class _FakeRedis:
    async def publish(self, *_args, **_kwargs):
        return 1

    async def delete(self, *_args, **_kwargs):
        return 1

@pytest.mark.asyncio
async def test_api_frames(async_client, db, redis):
    # Create a frame:
    await new_frame(db, redis, 'TestFrame', 'localhost', 'localhost')

    # GET /api/frames
    response = await async_client.get('/api/frames')
    assert response.status_code == 200
    data = response.json()
    assert 'frames' in data
    assert len(data['frames']) == 1
    assert data['frames'][0]['name'] == 'TestFrame'

@pytest.mark.asyncio
async def test_api_frame_get_found(async_client, db, redis):
    frame = await new_frame(db, redis, 'FoundFrame', 'localhost', 'localhost')
    response = await async_client.get(f'/api/frames/{frame.id}')
    assert response.status_code == 200
    data = response.json()
    assert 'frame' in data
    assert data['frame']['name'] == 'FoundFrame'

@pytest.mark.asyncio
async def test_api_frame_get_not_found(async_client):
    # Large ID that doesn't exist
    response = await async_client.get('/api/frames/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == 'Frame not found'


@pytest.mark.asyncio
async def test_api_frame_get_image_cached(async_client, db, redis):
    # Create the frame
    frame = await new_frame(db, redis, 'CachedImageFrame', 'localhost', 'localhost')
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(cache_key, b'cached_image_data')

    image_url = f'/api/frames/{frame.id}/image?t=-1'
    response = await async_client.get(image_url)
    assert response.status_code == 200
    assert response.content == b'cached_image_data'

@pytest.mark.asyncio
async def test_api_frame_event_render(async_client, db, redis):
    """
    Patch post to return 200. The route then returns "OK", which we check via response.text.
    """
    frame = await new_frame(db, redis, 'RenderFrame', 'example.com', 'localhost')

    class MockResponse:
        status_code = 200
        def json(self):
            return {}
        @property
        def text(self):
            return 'OK'

    async def mock_httpx_post(url, **kwargs):
        return MockResponse()

    with patch.object(httpx.AsyncClient, 'post', side_effect=mock_httpx_post):
        response = await async_client.post(f'/api/frames/{frame.id}/event/render')
        assert response.status_code == 200
        assert response.text == 'OK'


@pytest.mark.asyncio
async def test_api_frame_reset_event(async_client, db, redis):
    frame = await new_frame(db, redis, 'ResetFrame', 'example.com', 'localhost')
    response = await async_client.post(f'/api/frames/{frame.id}/reset')
    assert response.status_code == 200
    assert response.text == '"Success"'


@pytest.mark.asyncio
async def test_api_frame_not_found_for_reset(async_client):
    """
    Currently the route does NOT check if the frame exists.
    So it always returns 200 "Success".
    """
    response = await async_client.post('/api/frames/999999/reset')
    assert response.status_code == 200
    assert response.text == '"Success"'


@pytest.mark.asyncio
async def test_api_frame_update_name(async_client, db, redis):
    frame = await new_frame(db, redis, 'InitialName', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"name": "Updated Name"})
    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.name == "Updated Name"


@pytest.mark.asyncio
async def test_api_frame_update_requires_admin_credentials_when_enabled(async_client, db, redis):
    frame = await new_frame(db, redis, 'AdminFrame', 'localhost', 'localhost')

    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={
            'frame_admin_auth': {
                'enabled': True,
                'user': 'admin',
                'pass': '',
            }
        },
    )

    assert resp.status_code == 422
    assert 'Username and password are required when frame admin is enabled' in json.dumps(resp.json()['detail'])


@pytest.mark.asyncio
async def test_api_frame_update_scenes_json_format(async_client, db, redis):
    frame = await new_frame(db, redis, 'SceneTest', 'localhost', 'localhost')
    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={"scenes": [{"sceneName":"Scene1"},{"sceneName":"Scene2"}]}
    )
    assert resp.status_code == 200
    db.expire_all()
    updated = db.get(Frame, frame.id)
    assert updated.scenes == [{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]


@pytest.mark.asyncio
async def test_api_frame_update_scenes_invalid(async_client, db, redis):
    frame = await new_frame(db, redis, 'SceneTest2', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"scenes": "not valid JSON"})
    assert resp.status_code == 422
    assert "Input should be a valid list" in json.dumps(resp.json()['detail'])


@pytest.mark.asyncio
async def test_api_frame_new(async_client):
    # Valid creation
    payload = {
        "name": "NewFrame",
        "frame_host": "myhost",
        "server_host": "myserver"
    }
    response = await async_client.post('/api/frames/new', json=payload)
    assert response.status_code == 200
    data = response.json()
    assert 'frame' in data
    assert data['frame']['name'] == "NewFrame"
    assert data['frame']['https_proxy']['enable'] is True
    assert data['frame']['https_proxy']['expose_only_port'] is True
    assert 'BEGIN CERTIFICATE' in data['frame']['https_proxy']['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in data['frame']['https_proxy']['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in data['frame']['https_proxy']['certs']['client_ca']
    assert data['frame']['https_proxy']['server_cert_not_valid_after'] is not None
    assert data['frame']['https_proxy']['client_ca_cert_not_valid_after'] is not None


@pytest.mark.asyncio
async def test_api_frame_new_missing_fields(async_client):
    # Missing frame_host
    payload = {
        "name": "BadFrame"
    }
    response = await async_client.post('/api/frames/new', json=payload)
    assert response.status_code == 422
    assert "Field required" in json.dumps(response.json()['detail'])


@pytest.mark.asyncio
async def test_api_frame_import(async_client, db, redis):
    payload = {
        "name": "ImportedFrame",
        "frame_host": "importhost",
        "server_host": "importserver"
    }
    resp = await async_client.post('/api/frames/import', json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data['frame']['name'] == "ImportedFrame"


@pytest.mark.asyncio
async def test_api_frame_delete(async_client, db, redis):
    frame = await new_frame(db, redis, 'DeleteMe', 'localhost', 'localhost')
    resp = await async_client.delete(f'/api/frames/{frame.id}')
    assert resp.status_code == 200
    assert resp.json()['message'] == "Frame deleted successfully"


@pytest.mark.asyncio
async def test_api_frame_delete_not_found(async_client):
    resp = await async_client.delete('/api/frames/999999')
    assert resp.status_code == 404
    assert resp.json()['detail'] == 'Frame not found'

@pytest.mark.asyncio
async def test_api_frame_get_image_with_cookie_no_token(no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'CookieImageFrame', 'localhost', 'localhost')
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(cache_key, b'cookie_cached_image_data')

    user = User(email='cookieframe@example.com')
    user.set_password('testpassword')
    db.add(user)
    db.commit()

    login_resp = await no_auth_client.post('/api/login', data={'username': 'cookieframe@example.com', 'password': 'testpassword'})
    assert login_resp.status_code == 200

    response = await no_auth_client.get(f'/api/frames/{frame.id}/image?t=-1')
    assert response.status_code == 200
    assert response.content == b'cookie_cached_image_data'


@pytest.mark.asyncio
async def test_api_frame_generate_tls_material_includes_validity_dates(async_client, db, redis):
    frame = await new_frame(db, redis, 'TlsFrame', 'localhost', 'localhost')

    response = await async_client.post(f'/api/frames/{frame.id}/tls/generate')
    assert response.status_code == 200

    data = response.json()
    assert 'BEGIN CERTIFICATE' in data['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in data['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in data['certs']['client_ca']
    assert data['server_cert_not_valid_after'] is not None
    assert data['client_ca_cert_not_valid_after'] is not None
    assert data['server_cert_not_valid_after'].endswith('+00:00')
    assert data['client_ca_cert_not_valid_after'].endswith('+00:00')


@pytest.mark.asyncio
async def test_api_frame_download_prebuilt_package_zip_packages_runtime_and_drivers(
    no_auth_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    fake_redis = _FakeRedis()
    app.dependency_overrides[get_current_user] = lambda: object()
    app.dependency_overrides[get_current_user_from_request] = lambda: object()
    app.dependency_overrides[get_redis] = lambda: fake_redis
    try:
        frame = await new_frame(db, fake_redis, 'PrebuiltFrame', 'localhost', 'localhost')
        frame.device = 'http.upload'
        frame.scenes = []
        db.add(frame)
        db.commit()

        target_slug = 'debian-bookworm-arm64'
        prebuilt_root = tmp_path / 'prebuilt-deps'
        _write_prebuilt_target(
            prebuilt_root,
            target_slug,
            {
                'frameos': {
                    'version': 'test-build',
                    'directory': 'frameos-test-build',
                    'artifact': 'frameos',
                    'contents': 'frameos-binary',
                },
                'driver_httpUpload': {
                    'version': 'test-build',
                    'directory': 'driver_httpUpload-test-build',
                    'artifact': 'httpUpload.so',
                    'driver_id': 'httpUpload',
                    'contents': 'http-upload-driver',
                },
            },
        )

        monkeypatch.setattr('app.api.frames.LOCAL_PREBUILT_DEPS_ROOT', prebuilt_root)

        async def fake_get_cpu_architecture(self):
            return 'aarch64'

        async def fake_get_distro(self):
            return 'debian'

        async def fake_get_distro_version(self):
            return 'bookworm'

        monkeypatch.setattr('app.api.frames.FrameDeployer.get_cpu_architecture', fake_get_cpu_architecture)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro', fake_get_distro)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro_version', fake_get_distro_version)

        async def fake_build_packaged_compiled_scenes(**_kwargs):
            return None

        monkeypatch.setattr(
            'app.api.frames._build_packaged_compiled_scenes',
            fake_build_packaged_compiled_scenes,
        )

        response = await no_auth_client.post(f'/api/frames/{frame.id}/download_prebuilt_package_zip')
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_from_request, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert 'frameos' in names
        assert 'frame.json' in names
        assert 'scenes.json' in names
        assert 'drivers/' in names
        assert 'drivers/httpUpload.so' in names
        assert 'scenes/' in names
        assert archive.read('frameos') == b'frameos-binary'
        assert archive.read('drivers/httpUpload.so') == b'http-upload-driver'
        frame_json = json.loads(archive.read('frame.json'))
        assert frame_json['name'] == 'PrebuiltFrame'
        assert json.loads(archive.read('scenes.json')) == []


@pytest.mark.asyncio
async def test_api_frame_download_prebuilt_package_zip_includes_python_driver_vendor_bundle(
    no_auth_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    fake_redis = _FakeRedis()
    app.dependency_overrides[get_current_user] = lambda: object()
    app.dependency_overrides[get_current_user_from_request] = lambda: object()
    app.dependency_overrides[get_redis] = lambda: fake_redis
    try:
        frame = await new_frame(db, fake_redis, 'VendorPackage', 'localhost', 'localhost')
        frame.device = 'pimoroni.inky_impression'
        frame.scenes = []
        db.add(frame)
        db.commit()

        target_slug = 'debian-bookworm-arm64'
        prebuilt_root = tmp_path / 'prebuilt-deps'
        _write_prebuilt_target(
            prebuilt_root,
            target_slug,
            {
                'frameos': {
                    'version': 'test-build',
                    'directory': 'frameos-test-build',
                    'artifact': 'frameos',
                    'contents': 'frameos-binary',
                },
                'driver_inkyPython': {
                    'version': 'test-build',
                    'directory': 'driver_inkyPython-test-build',
                    'artifact': 'inkyPython.so',
                    'driver_id': 'inkyPython',
                    'contents': 'inky-python-driver',
                },
                'driver_gpioButton': {
                    'version': 'test-build',
                    'directory': 'driver_gpioButton-test-build',
                    'artifact': 'gpioButton.so',
                    'driver_id': 'gpioButton',
                    'contents': 'gpio-button-driver',
                },
            },
        )
        vendor_root = tmp_path / 'vendor'
        (vendor_root / 'inkyPython').mkdir(parents=True, exist_ok=True)
        (vendor_root / 'inkyPython' / 'requirements.txt').write_text('inky==1.0.0\n', encoding='utf-8')
        (vendor_root / 'inkyPython' / 'turnOn.py').write_text('print("on")\n', encoding='utf-8')
        (vendor_root / 'inkyPython' / 'env').mkdir(parents=True, exist_ok=True)
        (vendor_root / 'inkyPython' / '__pycache__').mkdir(parents=True, exist_ok=True)
        (vendor_root / 'inkyPython' / 'env' / 'ignore.txt').write_text('ignore\n', encoding='utf-8')
        (vendor_root / 'inkyPython' / '__pycache__' / 'ignore.pyc').write_bytes(b'cache')

        monkeypatch.setattr('app.api.frames.LOCAL_PREBUILT_DEPS_ROOT', prebuilt_root)
        monkeypatch.setattr('app.api.frames.LOCAL_FRAMEOS_VENDOR_ROOT', vendor_root)

        async def fake_get_cpu_architecture(self):
            return 'aarch64'

        async def fake_get_distro(self):
            return 'debian'

        async def fake_get_distro_version(self):
            return 'bookworm'

        monkeypatch.setattr('app.api.frames.FrameDeployer.get_cpu_architecture', fake_get_cpu_architecture)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro', fake_get_distro)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro_version', fake_get_distro_version)

        async def fake_build_packaged_compiled_scenes(**_kwargs):
            return None

        monkeypatch.setattr(
            'app.api.frames._build_packaged_compiled_scenes',
            fake_build_packaged_compiled_scenes,
        )

        response = await no_auth_client.post(f'/api/frames/{frame.id}/download_prebuilt_package_zip')
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_from_request, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert 'drivers/inkyPython.so' in names
        assert 'drivers/gpioButton.so' in names
        assert 'vendor/' in names
        assert 'vendor/inkyPython/requirements.txt' in names
        assert 'vendor/inkyPython/turnOn.py' in names
        assert 'vendor/inkyPython/env/ignore.txt' not in names
        assert 'vendor/inkyPython/__pycache__/ignore.pyc' not in names
        assert archive.read('vendor/inkyPython/requirements.txt') == b'inky==1.0.0\n'


@pytest.mark.asyncio
async def test_api_frame_download_prebuilt_package_zip_builds_runtime_for_interpreted_scenes(
    no_auth_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    fake_redis = _FakeRedis()
    app.dependency_overrides[get_current_user] = lambda: object()
    app.dependency_overrides[get_current_user_from_request] = lambda: object()
    app.dependency_overrides[get_redis] = lambda: fake_redis
    try:
        frame = await new_frame(db, fake_redis, 'InterpretedPackage', 'localhost', 'localhost')
        frame.device = 'http.upload'
        frame.scenes = [{'id': 'interpreted', 'settings': {'execution': 'interpreted'}}]
        db.add(frame)
        db.commit()

        target_slug = 'debian-bookworm-arm64'
        prebuilt_root = tmp_path / 'prebuilt-deps'
        _write_prebuilt_target(
            prebuilt_root,
            target_slug,
            {
                'frameos': {
                    'version': 'stale-build',
                    'directory': 'frameos-stale-build',
                    'artifact': 'frameos',
                    'contents': 'stale-frameos-binary',
                },
                'quickjs': {
                    'version': '1',
                    'directory': 'quickjs-1',
                },
                'lgpio': {
                    'version': '1',
                    'directory': 'lgpio-1',
                },
                'driver_httpUpload': {
                    'version': 'test-build',
                    'directory': 'driver_httpUpload-test-build',
                    'artifact': 'httpUpload.so',
                    'driver_id': 'httpUpload',
                    'contents': 'http-upload-driver',
                },
            },
        )

        built_runtime = tmp_path / 'built-frameos'
        built_runtime.write_bytes(b'built-runtime-binary')

        monkeypatch.setattr('app.api.frames.LOCAL_PREBUILT_DEPS_ROOT', prebuilt_root)

        async def fake_get_cpu_architecture(self):
            return 'aarch64'

        async def fake_get_distro(self):
            return 'debian'

        async def fake_get_distro_version(self):
            return 'bookworm'

        monkeypatch.setattr('app.api.frames.FrameDeployer.get_cpu_architecture', fake_get_cpu_architecture)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro', fake_get_distro)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro_version', fake_get_distro_version)

        async def fake_build_packaged_runtime_binary(**_kwargs):
            return built_runtime

        async def fake_build_packaged_compiled_scenes(**_kwargs):
            return None

        monkeypatch.setattr('app.api.frames._build_packaged_runtime_binary', fake_build_packaged_runtime_binary)
        monkeypatch.setattr('app.api.frames._build_packaged_compiled_scenes', fake_build_packaged_compiled_scenes)

        response = await no_auth_client.post(f'/api/frames/{frame.id}/download_prebuilt_package_zip')
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_from_request, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read('frameos') == b'built-runtime-binary'
        assert archive.read('drivers/httpUpload.so') == b'http-upload-driver'
        assert json.loads(archive.read('scenes.json')) == [{'id': 'interpreted', 'settings': {'execution': 'interpreted'}}]


@pytest.mark.asyncio
async def test_api_frame_download_prebuilt_package_zip_includes_compiled_scenes(
    no_auth_client,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    fake_redis = _FakeRedis()
    app.dependency_overrides[get_current_user] = lambda: object()
    app.dependency_overrides[get_current_user_from_request] = lambda: object()
    app.dependency_overrides[get_redis] = lambda: fake_redis
    try:
        frame = await new_frame(db, fake_redis, 'PackagedScenes', 'localhost', 'localhost')
        frame.device = 'http.upload'
        frame.scenes = [{'id': 'compiled-demo', 'name': 'Compiled Demo', 'settings': {'execution': 'compiled'}}]
        db.add(frame)
        db.commit()

        target_slug = 'debian-bookworm-arm64'
        prebuilt_root = tmp_path / 'prebuilt-deps'
        _write_prebuilt_target(
            prebuilt_root,
            target_slug,
            {
                'frameos': {
                    'version': 'stale-build',
                    'directory': 'frameos-stale-build',
                    'artifact': 'frameos',
                    'contents': 'stale-frameos-binary',
                },
                'driver_httpUpload': {
                    'version': 'test-build',
                    'directory': 'driver_httpUpload-test-build',
                    'artifact': 'httpUpload.so',
                    'driver_id': 'httpUpload',
                    'contents': 'http-upload-driver',
                },
            },
        )

        compiled_scenes_dir = tmp_path / 'compiled-scenes'
        compiled_scenes_dir.mkdir(parents=True, exist_ok=True)
        (compiled_scenes_dir / 'demo.so').write_bytes(b'compiled-scene')
        built_runtime = tmp_path / 'built-frameos'
        built_runtime.write_bytes(b'built-runtime-binary')
        runtime_build_calls = 0

        monkeypatch.setattr('app.api.frames.LOCAL_PREBUILT_DEPS_ROOT', prebuilt_root)

        async def fake_get_cpu_architecture(self):
            return 'aarch64'

        async def fake_get_distro(self):
            return 'debian'

        async def fake_get_distro_version(self):
            return 'bookworm'

        monkeypatch.setattr('app.api.frames.FrameDeployer.get_cpu_architecture', fake_get_cpu_architecture)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro', fake_get_distro)
        monkeypatch.setattr('app.api.frames.FrameDeployer.get_distro_version', fake_get_distro_version)

        async def fake_build_packaged_runtime_binary(**_kwargs):
            nonlocal runtime_build_calls
            runtime_build_calls += 1
            return built_runtime

        async def fake_build_packaged_scenes(**_kwargs):
            return compiled_scenes_dir

        monkeypatch.setattr('app.api.frames._build_packaged_runtime_binary', fake_build_packaged_runtime_binary)
        monkeypatch.setattr('app.api.frames._build_packaged_compiled_scenes', fake_build_packaged_scenes)

        response = await no_auth_client.post(f'/api/frames/{frame.id}/download_prebuilt_package_zip')
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_from_request, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200
    assert runtime_build_calls == 1

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read('frameos') == b'built-runtime-binary'
        assert archive.read('scenes/demo.so') == b'compiled-scene'


@pytest.mark.asyncio
async def test_build_packaged_compiled_scenes_passes_explicit_scene_build_dirs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    target_dir = tmp_path / "prebuilt"
    (target_dir / "quickjs-1").mkdir(parents=True, exist_ok=True)
    (target_dir / "lgpio-1").mkdir(parents=True, exist_ok=True)
    compiled_scenes_dir = tmp_path / "compiled-scenes"
    compiled_scenes_dir.mkdir(parents=True, exist_ok=True)

    frame = SimpleNamespace(
        id=1,
        scenes=[
            {"id": "compiled-demo", "settings": {"execution": "compiled"}},
            {"id": "ignored", "settings": {"execution": "interpreted"}},
            {"id": "other/demo", "settings": {}},
        ],
    )
    requested_kwargs: dict[str, object] = {}

    class FakeBuilder:
        def __init__(self, **_kwargs):
            return None

        async def prepare_source_dir(self) -> str:
            return str(tmp_path / "source")

        async def prepare_build_archive(self, **_kwargs) -> tuple[str, str]:
            return str(tmp_path / "build"), str(tmp_path / "build.tar.gz")

        async def build_requested_artifacts(self, **kwargs):
            requested_kwargs.update(kwargs)
            return SimpleNamespace(
                artifacts=SimpleNamespace(scenes_dir=str(compiled_scenes_dir))
            )

    monkeypatch.setattr(frames_api, "find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr(frames_api, "FrameBinaryBuilder", FakeBuilder)

    result = await frames_api._build_packaged_compiled_scenes(
        db=None,
        redis=None,
        frame=frame,
        temp_dir=str(tmp_path),
        deployer=SimpleNamespace(build_id="build123"),
        target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
        target_slug="debian-bookworm-arm64",
        target_dir=target_dir,
        components={
            "quickjs": {"directory": "quickjs-1", "version": "1"},
            "lgpio": {"directory": "lgpio-1", "version": "1"},
        },
    )

    assert result == compiled_scenes_dir
    assert requested_kwargs["build_binary"] is False
    assert requested_kwargs["build_all_scenes"] is True
    assert requested_kwargs["build_scene_dirs"] == [
        "scene_builds/compiled_demo",
        "scene_builds/other_demo",
    ]


@pytest.mark.asyncio
async def test_build_packaged_compiled_scenes_skips_builtin_mode(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    target_dir = tmp_path / "prebuilt"
    (target_dir / "quickjs-1").mkdir(parents=True, exist_ok=True)
    (target_dir / "lgpio-1").mkdir(parents=True, exist_ok=True)

    result = await frames_api._build_packaged_compiled_scenes(
        db=None,
        redis=None,
        frame=SimpleNamespace(
            id=1,
            rpios={"compiledModulesMode": "builtin"},
            scenes=[{"id": "compiled-demo", "settings": {"execution": "compiled"}}],
        ),
        temp_dir=str(tmp_path),
        deployer=SimpleNamespace(build_id="build123"),
        target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
        target_slug="debian-bookworm-arm64",
        target_dir=target_dir,
        components={
            "quickjs": {"directory": "quickjs-1", "version": "1"},
            "lgpio": {"directory": "lgpio-1", "version": "1"},
        },
    )

    assert result is None


@pytest.mark.asyncio
async def test_build_packaged_runtime_binary_uses_prebuilt_deps_and_skips_compiled_scenes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    target_dir = tmp_path / "prebuilt"
    (target_dir / "quickjs-1").mkdir(parents=True, exist_ok=True)
    (target_dir / "lgpio-1").mkdir(parents=True, exist_ok=True)
    built_binary = tmp_path / "frameos"
    built_binary.write_bytes(b"binary")

    frame = SimpleNamespace(
        id=1,
        scenes=[{"id": "interpreted", "settings": {"execution": "interpreted"}}],
    )
    source_prepare_kwargs: dict[str, object] = {}
    requested_kwargs: dict[str, object] = {}

    class FakeBuilder:
        def __init__(self, **_kwargs):
            return None

        async def prepare_source_dir(self, **kwargs) -> str:
            source_prepare_kwargs.update(kwargs)
            return str(tmp_path / "source")

        async def prepare_build_archive(self, **kwargs) -> tuple[str, str]:
            assert kwargs["build_binary"] is True
            assert kwargs["build_all_scenes"] is False
            assert kwargs["drivers_override"] == {}
            return str(tmp_path / "build"), str(tmp_path / "build.tar.gz")

        async def build_requested_artifacts(self, **kwargs):
            requested_kwargs.update(kwargs)
            return SimpleNamespace(
                artifacts=SimpleNamespace(binary_path=str(built_binary))
            )

    monkeypatch.setattr(frames_api, "find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr(frames_api, "FrameBinaryBuilder", FakeBuilder)

    result = await frames_api._build_packaged_runtime_binary(
        db=None,
        redis=None,
        frame=frame,
        temp_dir=str(tmp_path),
        deployer=SimpleNamespace(build_id="build123"),
        target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
        target_slug="debian-bookworm-arm64",
        target_dir=target_dir,
        components={
            "quickjs": {"directory": "quickjs-1", "version": "1"},
            "lgpio": {"directory": "lgpio-1", "version": "1"},
        },
    )

    assert result == built_binary
    assert source_prepare_kwargs["drivers_override"] == {}
    assert requested_kwargs["prebuilt_target"] == "debian-bookworm-arm64"
    assert requested_kwargs["build_binary"] is True
    assert requested_kwargs["build_all_scenes"] is False


@pytest.mark.asyncio
async def test_build_packaged_runtime_binary_keeps_drivers_in_builtin_mode(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    target_dir = tmp_path / "prebuilt"
    (target_dir / "quickjs-1").mkdir(parents=True, exist_ok=True)
    (target_dir / "lgpio-1").mkdir(parents=True, exist_ok=True)
    built_binary = tmp_path / "frameos"
    built_binary.write_bytes(b"binary")

    frame = SimpleNamespace(
        id=1,
        device="waveshare.EPD_10in3",
        gpio_buttons=[],
        rpios={"compiledModulesMode": "builtin"},
        scenes=[],
    )
    source_prepare_kwargs: dict[str, object] = {}

    class FakeBuilder:
        def __init__(self, **_kwargs):
            return None

        async def prepare_source_dir(self, **kwargs) -> str:
            source_prepare_kwargs.update(kwargs)
            return str(tmp_path / "source")

        async def prepare_build_archive(self, **kwargs) -> tuple[str, str]:
            assert kwargs["drivers_override"] is None
            return str(tmp_path / "build"), str(tmp_path / "build.tar.gz")

        async def build_requested_artifacts(self, **_kwargs):
            return SimpleNamespace(
                artifacts=SimpleNamespace(binary_path=str(built_binary))
            )

    monkeypatch.setattr(frames_api, "find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr(frames_api, "FrameBinaryBuilder", FakeBuilder)

    result = await frames_api._build_packaged_runtime_binary(
        db=None,
        redis=None,
        frame=frame,
        temp_dir=str(tmp_path),
        deployer=SimpleNamespace(build_id="build123"),
        target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
        target_slug="debian-bookworm-arm64",
        target_dir=target_dir,
        components={
            "quickjs": {"directory": "quickjs-1", "version": "1"},
            "lgpio": {"directory": "lgpio-1", "version": "1"},
        },
    )

    assert result == built_binary
    assert source_prepare_kwargs["drivers_override"] is None
