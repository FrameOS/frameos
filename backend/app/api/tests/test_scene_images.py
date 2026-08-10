import io

import pytest
from PIL import Image

from app.models import new_frame
from app.models.repository import Repository
from app.models.scene_image import SceneImage
from app.models.template import Template


def _png_bytes(color: tuple[int, int, int] = (10, 20, 30), size: tuple[int, int] = (40, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def _fake_httpx(monkeypatch, responses: dict[str, tuple[int, bytes]], seen: list[str] | None = None):
    """Stand in for the outbound cover fetch, recording every URL requested."""

    class FakeResponse:
        def __init__(self, status_code: int, content: bytes):
            self.status_code = status_code
            self.content = content

    class FakeClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None, timeout=None):
            if seen is not None:
                seen.append(url)
            if url not in responses:
                raise AssertionError(f"unexpected URL fetched: {url}")
            return FakeResponse(*responses[url])

    import app.api.scene_images as scene_images_module

    monkeypatch.setattr(scene_images_module.httpx, "AsyncClient", FakeClient)


@pytest.mark.asyncio
async def test_copy_scene_image_from_allowed_repository_url(async_client, db, redis, monkeypatch):
    """Installing a store scene copies its cover server-side: the browser
    cannot fetch it (the store serves covers without a CORS header)."""
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    image_url = "https://scenes.example.com/api/store/scenes/abc/image"
    db.add(
        Repository(
            project_id=async_client.project_id,
            name="Store",
            url="https://cloud.example.com/api/store/2026.1.1/repository.json",
            templates=[{"name": "Sunrise", "image": image_url}],
        )
    )
    db.commit()

    _fake_httpx(monkeypatch, {image_url: (200, _png_bytes((1, 2, 3), (64, 48)))})

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/scene-1/copy', json={"url": image_url}
    )
    assert response.status_code == 201, response.text
    assert response.json()["width"] == 64

    row = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='scene-1').first()
    assert row is not None
    with Image.open(io.BytesIO(row.image)) as stored:
        assert stored.size == (64, 48)
        assert stored.convert("RGB").getpixel((0, 0)) == (1, 2, 3)
    assert row.thumb_image  # tiles render the thumbnail


@pytest.mark.asyncio
async def test_copy_scene_image_rejects_url_outside_known_repositories(async_client, db, redis, monkeypatch):
    """The URL allowlist is the SSRF guard: only covers a repository of this
    project actually advertises may be fetched."""
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    db.add(
        Repository(
            project_id=async_client.project_id,
            name="Store",
            url="https://cloud.example.com/api/store/repository.json",
            templates=[{"name": "Sunrise", "image": "https://scenes.example.com/api/store/scenes/abc/image"}],
        )
    )
    db.commit()

    fetched: list[str] = []
    _fake_httpx(monkeypatch, {}, fetched)

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/scene-1/copy',
        json={"url": "http://169.254.169.254/latest/meta-data/"},
    )
    assert response.status_code == 400
    assert "known repository" in response.json()["detail"]
    assert fetched == []
    assert db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='scene-1').first() is None


@pytest.mark.asyncio
async def test_copy_scene_image_does_not_follow_redirects(async_client, db, redis, monkeypatch):
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    image_url = "https://scenes.example.com/api/store/scenes/abc/image"
    db.add(
        Repository(
            project_id=async_client.project_id,
            name="Store",
            url="https://cloud.example.com/api/store/repository.json",
            templates=[{"image": image_url}],
        )
    )
    db.commit()

    captured: dict = {}

    class FakeResponse:
        status_code = 302
        content = b""

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None, timeout=None):
            return FakeResponse()

    import app.api.scene_images as scene_images_module

    monkeypatch.setattr(scene_images_module.httpx, "AsyncClient", FakeClient)

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/scene-1/copy', json={"url": image_url}
    )
    assert captured.get("follow_redirects") is False
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_copy_scene_image_from_another_scene(async_client, db, redis):
    """Duplicating a scene carries the original's snapshot over — locally,
    with no outbound request."""
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    source_png = _png_bytes((200, 100, 50), (24, 16))
    upload = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/original',
        content=source_png,
    )
    assert upload.status_code == 201, upload.text

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/copy-of-original/copy',
        json={"source_scene_id": "original"},
    )
    assert response.status_code == 201, response.text

    original = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='original').first()
    duplicate = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='copy-of-original').first()
    assert duplicate is not None
    assert duplicate.image == original.image
    assert (duplicate.width, duplicate.height) == (24, 16)


@pytest.mark.asyncio
async def test_copy_scene_image_from_missing_scene_is_404(async_client, db, redis):
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/new-scene/copy',
        json={"source_scene_id": "never-rendered"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_copy_scene_image_from_local_template(async_client, db, redis):
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    template = Template(
        project_id=async_client.project_id,
        name="Local",
        scenes=[],
        image=_png_bytes((9, 9, 9), (30, 20)),
        image_width=30,
        image_height=20,
    )
    db.add(template)
    db.commit()
    db.refresh(template)

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/scene-1/copy', json={"template_id": template.id}
    )
    assert response.status_code == 201, response.text
    row = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='scene-1').first()
    assert row is not None and (row.width, row.height) == (30, 20)


@pytest.mark.asyncio
async def test_copy_scene_image_from_system_repository_path(async_client, db, redis, monkeypatch, tmp_path):
    """Bundled repository covers are read off disk, never over the network."""
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')

    import json

    import app.api.repositories as repositories_module

    template_dir = tmp_path / "samples" / "sunrise"
    template_dir.mkdir(parents=True)
    (template_dir / "image.png").write_bytes(_png_bytes((5, 6, 7), (16, 12)))
    (template_dir / "template.json").write_text(json.dumps({"name": "Sunrise", "image": "./image.png"}))
    monkeypatch.setattr(repositories_module, "SYSTEM_REPOSITORIES_PATH", tmp_path)

    fetched: list[str] = []
    _fake_httpx(monkeypatch, {}, fetched)

    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_images/scene-1/copy',
        json={"url": "/api/repositories/system/samples/templates/sunrise/image"},
    )
    assert response.status_code == 201, response.text
    assert fetched == []
    row = db.query(SceneImage).filter_by(frame_id=frame.id, scene_id='scene-1').first()
    assert row is not None and (row.width, row.height) == (16, 12)


@pytest.mark.asyncio
async def test_copy_scene_image_without_a_source_is_400(async_client, db, redis):
    frame = await new_frame(db, redis, 'CoverFrame', 'localhost', 'localhost')
    response = await async_client.post(f'/api/frames/{frame.id}/scene_images/scene-1/copy', json={})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_copy_scene_image_unknown_frame_is_404(async_client, db, redis):
    response = await async_client.post('/api/frames/99999/scene_images/scene-1/copy', json={"url": "x"})
    assert response.status_code == 404
