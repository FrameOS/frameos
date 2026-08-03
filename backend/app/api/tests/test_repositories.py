import asyncio
import json
from datetime import datetime, timedelta

import pytest
from app.api.repositories import cloud_store_repository_url
from app.models import Repository
from app.models.user import User
from app.utils.versions import current_frameos_version
from sqlalchemy.exc import InvalidRequestError


async def _drain_background_refreshes():
    """Wait for the refresh tasks GET /api/repositories schedules."""
    from app.api.repositories import background_refresh_tasks

    for _ in range(100):
        if not background_refresh_tasks:
            break
        await asyncio.gather(*list(background_refresh_tasks), return_exceptions=True)
    await asyncio.sleep(0)

@pytest.mark.asyncio
async def test_create_repository(async_client, db):
    data = {'url': 'http://example.com/repo.json'}
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 201
    repo = db.query(Repository).first()
    assert repo is not None
    assert repo.url == 'http://example.com/repo.json'

@pytest.mark.asyncio
async def test_create_repository_invalid_input(async_client):
    # Missing URL
    data = {}
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 422
    assert "Field required" in json.dumps(response.json()['detail'])

@pytest.mark.asyncio
async def test_get_repositories(async_client, db):
    # Possibly your code also ensures the "samples" and "gallery" repos are created
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    # Should be a list
    repos = response.json()
    assert isinstance(repos, list)


@pytest.mark.asyncio
async def test_get_system_repositories_includes_packaged_templates(async_client):
    response = await async_client.get('/api/repositories/system')
    assert response.status_code == 200

    repos = response.json()
    repo_ids = {repo["id"] for repo in repos}
    assert "system-samples" in repo_ids
    assert "system-gallery" in repo_ids
    assert all(repo.get("templates") for repo in repos)

    # Listings carry metadata only; scenes are fetched separately via scenesUrl.
    # Every template has a stable id (its directory slug) and a version (an
    # explicit template.json version or a content hash of its scenes), so
    # installed scenes can track their origin and detect updates.
    for repo in repos:
        for template in repo["templates"]:
            assert "scenes" not in template
            assert template["scenesUrl"].startswith("/api/repositories/system/")
            assert template["scenesUrl"].endswith("/scenes.json")
            assert template["id"]
            assert template["scenesUrl"].split("/templates/")[1] == f'{template["id"]}/scenes.json'
            assert isinstance(template["version"], str) and len(template["version"]) > 0

    # Templates that cannot run on ESP32 frames carry embedded: false.
    samples = next(repo for repo in repos if repo["id"] == "system-samples")
    by_name = {template["name"]: template for template in samples["templates"]}
    assert by_name["Chromium Screenshot"]["embedded"] is False
    assert by_name["Webcam RSTP"]["embedded"] is False
    assert "embedded" not in by_name["Weather"]


@pytest.mark.asyncio
async def test_get_system_repository_template_scenes(async_client):
    response = await async_client.get('/api/repositories/system/samples/templates/Calendar/scenes.json')
    assert response.status_code == 200

    scenes = response.json()
    assert isinstance(scenes, list)
    assert len(scenes) > 0
    assert scenes[0].get("nodes")


@pytest.mark.asyncio
async def test_get_system_repository_template_scenes_not_found(async_client):
    response = await async_client.get('/api/repositories/system/samples/templates/Missing/scenes.json')
    assert response.status_code == 404

    response = await async_client.get('/api/repositories/system/%2e%2e/templates/Calendar/scenes.json')
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_repositories_persists_the_daily_refresh(async_client, db, monkeypatch):
    """A stale repository is refreshed *and the refresh is written back*.

    The picker renders `template.image` straight from this cached copy, so a
    refresh that never lands leaves the UI pointing at scene images the store
    has long since dropped — every card renders blank.
    """
    async def fake_update(self):
        self.templates = [{"name": "New", "image": "https://example.com/new/image"}]
        self.last_updated_at = datetime.utcnow()

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    repo = Repository(
        project_id=async_client.project_id,
        name="Stale store",
        url="https://example.com/repository.json",
        templates=[{"name": "Old", "image": "https://example.com/old/image"}],
        last_updated_at=datetime.utcnow() - timedelta(days=3),
    )
    db.add(repo)
    db.commit()

    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    await _drain_background_refreshes()

    db.expire_all()
    refreshed = db.query(Repository).filter_by(id=repo.id).one()
    assert refreshed.templates == [{"name": "New", "image": "https://example.com/new/image"}]
    assert refreshed.last_updated_at > datetime.utcnow() - timedelta(minutes=1)


@pytest.mark.asyncio
async def test_get_repository(async_client, db):
    repo = Repository(project_id=async_client.project_id, name="Test Repo", url="http://example.com/test.json")
    db.add(repo)
    db.commit()
    response = await async_client.get(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    data = response.json()
    assert data['name'] == 'Test Repo'

@pytest.mark.asyncio
async def test_update_repository(async_client, db):
    repo = Repository(project_id=async_client.project_id, name="Old Repo", url="http://example.com/old.json")
    db.add(repo)
    db.commit()

    updated_data = {"name": "Updated Repo", "url": "http://example.com/updated.json"}
    response = await async_client.patch(f'/api/repositories/{repo.id}', json=updated_data)
    assert response.status_code == 200
    db.refresh(repo)
    assert repo.name == "Updated Repo"
    assert repo.url == "http://example.com/updated.json"

@pytest.mark.asyncio
async def test_delete_repository(async_client, db):
    repo = Repository(project_id=async_client.project_id, name="DeleteMe", url="http://example.com/delete.json")
    db.add(repo)
    db.commit()

    response = await async_client.delete(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    assert response.json()['message'] == "Repository deleted successfully"

    try:
        db.refresh(repo)
        raise AssertionError("Repository was not deleted")
    except InvalidRequestError:
        pass

    try:
        db.get(Repository, repo.id)
        raise AssertionError("Repository was not deleted")
    except InvalidRequestError:
        pass

@pytest.mark.asyncio
async def test_delete_nonexistent_repository(async_client):
    response = await async_client.delete('/api/repositories/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == "Repository not found"


@pytest.mark.asyncio
async def test_system_repository_image_allows_session_cookie_without_token(no_auth_client, db):
    user = User(email="reposcookie@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    login_resp = await no_auth_client.post(
        '/api/login',
        data={'username': 'reposcookie@example.com', 'password': 'testpassword'},
    )
    assert login_resp.status_code == 200

    response = await no_auth_client.get('/api/repositories/system/samples/templates/Calendar/image?t=-1')
    assert response.status_code == 200
    assert response.content


@pytest.mark.asyncio
async def test_get_repositories_seeds_cloud_store_once(async_client, db, monkeypatch):
    """A connected cloud link seeds once per provider; deletion is respected."""
    from app.models.cloud import CloudBackendLink
    from app.models.settings import Settings
    from app.utils import cloud_link as cloud_link_utils

    async def fake_update(self):
        self.templates = []

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    link = CloudBackendLink(
        provider_url="https://cloud.frameos.net",
        status="connected",
        access_token=cloud_link_utils.encrypt_cloud_secret("link-token"),
        linked_client_id="lc-1",
        scope="backend:link backend:read",
        local_origin="http://test",
    )
    db.add(link)
    db.commit()

    # The seeded index is the version-filtered one: it only lists scenes that
    # run on the FrameOS this backend ships.
    store_url = cloud_store_repository_url("https://cloud.frameos.net")
    assert store_url == f"https://cloud.frameos.net/api/store/{current_frameos_version()}/repository.json"

    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    assert store_url in [r["url"] for r in response.json()]
    marker = db.query(Settings).filter_by(
        project_id=async_client.project_id, key="@system/cloud_store_repository_added"
    ).one()
    assert marker.value == store_url

    repo = db.query(Repository).filter_by(url=store_url).first()
    delete = await async_client.delete(f'/api/repositories/{repo.id}')
    assert delete.status_code == 200

    # Not re-added behind the user's back.
    response = await async_client.get('/api/repositories')
    assert store_url not in [r["url"] for r in response.json()]

    # Changing providers resets the one-time choice for the new provider and
    # records its URL, even when the previous provider's store was deleted.
    link.provider_url = "https://cloud.example.com"
    db.commit()
    next_store_url = cloud_store_repository_url("https://cloud.example.com")
    response = await async_client.get('/api/repositories')
    assert next_store_url in [r["url"] for r in response.json()]
    db.refresh(marker)
    assert marker.value == next_store_url


@pytest.mark.asyncio
async def test_get_repositories_migrates_legacy_marker_after_provider_change(async_client, db, monkeypatch):
    from app.models.cloud import CloudBackendLink
    from app.models.settings import Settings

    async def fake_update(self):
        self.templates = []

    monkeypatch.setattr(Repository, "update_templates", fake_update)
    db.add(
        CloudBackendLink(
            provider_url="https://cloud.example.com",
            status="connected",
            linked_client_id="lc-2",
            scope="backend:link backend:read",
            local_origin="http://test",
        )
    )
    db.add(
        Settings(
            project_id=async_client.project_id,
            key="@system/cloud_store_repository_added",
            value="true",
        )
    )
    old_store_url = "https://cloud.frameos.net/api/store/repository.json"
    db.add(Repository(project_id=async_client.project_id, name="Old cloud store", url=old_store_url))
    db.commit()

    new_store_url = cloud_store_repository_url("https://cloud.example.com")
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    urls = [repository["url"] for repository in response.json()]
    assert old_store_url not in urls
    assert new_store_url in urls
    marker = db.query(Settings).filter_by(
        project_id=async_client.project_id, key="@system/cloud_store_repository_added"
    ).one()
    assert marker.value == new_store_url


def _connected_link(provider_url: str, client_id: str):
    from app.models.cloud import CloudBackendLink

    return CloudBackendLink(
        provider_url=provider_url,
        status="connected",
        linked_client_id=client_id,
        scope="backend:link backend:read",
        local_origin="http://test",
    )


@pytest.mark.asyncio
async def test_get_repositories_migrates_unversioned_store_to_versioned(async_client, db, monkeypatch):
    """An install seeded before versioned indexes moves over, in place, once."""
    from app.models.settings import Settings

    async def fake_update(self):
        self.templates = [{"name": "Versioned", "image": "https://cloud.example.com/api/store/scenes/x/image"}]

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    unversioned_url = "https://cloud.example.com/api/store/repository.json"
    db.add(_connected_link("https://cloud.example.com", "lc-versioned"))
    db.add(
        Settings(
            project_id=async_client.project_id,
            key="@system/cloud_store_repository_added",
            value=unversioned_url,
        )
    )
    seeded = Repository(project_id=async_client.project_id, name="FrameOS Cloud store", url=unversioned_url)
    db.add(seeded)
    db.commit()
    seeded_id = seeded.id

    versioned_url = cloud_store_repository_url("https://cloud.example.com")
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    store_repositories = [r for r in response.json() if "/api/store/" in (r["url"] or "")]
    # Migrated, not duplicated, and the row (and its id, which installed scenes
    # remember) survives so its templates refresh in place.
    assert [r["url"] for r in store_repositories] == [versioned_url]
    assert store_repositories[0]["id"] == seeded_id
    assert store_repositories[0]["templates"][0]["name"] == "Versioned"

    marker = db.query(Settings).filter_by(
        project_id=async_client.project_id, key="@system/cloud_store_repository_added"
    ).one()
    assert marker.value == versioned_url

    # Idempotent: a second listing changes nothing.
    response = await async_client.get('/api/repositories')
    assert [r["url"] for r in response.json() if "/api/store/" in (r["url"] or "")] == [versioned_url]


@pytest.mark.asyncio
async def test_version_bump_does_not_resurrect_a_deleted_store(async_client, db, monkeypatch):
    """Deleting the store is respected across FrameOS upgrades."""
    from app.models.settings import Settings

    async def fake_update(self):
        self.templates = []

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    db.add(_connected_link("https://cloud.example.com", "lc-deleted"))
    db.add(
        Settings(
            project_id=async_client.project_id,
            key="@system/cloud_store_repository_added",
            value="https://cloud.example.com/api/store/2000.1.1/repository.json",
        )
    )
    db.commit()

    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    assert [r for r in response.json() if "/api/store/" in (r["url"] or "")] == []
    marker = db.query(Settings).filter_by(
        project_id=async_client.project_id, key="@system/cloud_store_repository_added"
    ).one()
    assert marker.value == cloud_store_repository_url("https://cloud.example.com")


@pytest.mark.asyncio
async def test_version_bump_leaves_a_user_edited_store_row_alone(async_client, db, monkeypatch):
    """A row the user re-pointed by hand is neither migrated nor duplicated."""
    from app.models.settings import Settings

    async def fake_update(self):
        self.templates = []

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    custom_url = "https://scenes.example.org/my/repository.json"
    db.add(_connected_link("https://cloud.example.com", "lc-custom"))
    db.add(
        Settings(
            project_id=async_client.project_id,
            key="@system/cloud_store_repository_added",
            value="https://cloud.example.com/api/store/2000.1.1/repository.json",
        )
    )
    db.add(Repository(project_id=async_client.project_id, name="My own store", url=custom_url))
    db.commit()

    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    assert [r["url"] for r in response.json()] == [custom_url]


@pytest.mark.asyncio
async def test_version_bump_drops_the_duplicate_when_the_user_added_the_new_index(async_client, db, monkeypatch):
    from app.models.settings import Settings

    async def fake_update(self):
        self.templates = []

    monkeypatch.setattr(Repository, "update_templates", fake_update)

    old_url = "https://cloud.example.com/api/store/2000.1.1/repository.json"
    versioned_url = cloud_store_repository_url("https://cloud.example.com")
    db.add(_connected_link("https://cloud.example.com", "lc-dupe"))
    db.add(
        Settings(
            project_id=async_client.project_id,
            key="@system/cloud_store_repository_added",
            value=old_url,
        )
    )
    db.add(Repository(project_id=async_client.project_id, name="Seeded", url=old_url))
    db.add(Repository(project_id=async_client.project_id, name="Added by hand", url=versioned_url))
    db.commit()

    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    urls = [r["url"] for r in response.json()]
    assert urls == [versioned_url]


@pytest.mark.asyncio
async def test_get_repositories_does_not_seed_store_without_link(async_client, db):
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    assert all("/api/store/" not in (r["url"] or "") for r in response.json())
