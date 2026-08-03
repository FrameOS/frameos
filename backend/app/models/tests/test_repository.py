import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from app.models.repository import Repository

@pytest.mark.asyncio
async def test_repository_create(db, default_project):
    repo = Repository(project_id=default_project.id, name="TestRepo", url="http://example.com/repo")
    db.add(repo)
    db.commit()
    assert repo.id is not None


@pytest.mark.asyncio
@patch("app.models.repository.httpx.AsyncClient")   # ➊ patch the *class*
async def test_repository_update_templates(mock_async_client_cls, db, default_project):
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "name": "My Repo",
        "description": "A sample repository",
        "templates": [{"title": "Template1"}],
    }

    mock_client = AsyncMock()
    mock_client.get.return_value = fake_response
    mock_async_client_cls.return_value = mock_client

    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = False   # propagate exceptions normally

    repo = Repository(project_id=default_project.id, name="OldName", url="http://example.com/repo")
    db.add(repo)
    db.commit()

    await repo.update_templates()
    db.commit()

    assert repo.name == "My Repo"
    assert repo.description == "A sample repository"
    assert len(repo.templates) == 1

    mock_client.get.assert_awaited_once_with("http://example.com/repo", timeout=10)


@pytest.mark.asyncio
@patch("app.models.repository.httpx.AsyncClient")
async def test_repository_resolves_relative_assets(mock_async_client_cls, db, default_project):
    """"./" assets resolve against the index URL; a null image is not fatal."""
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "templates": [
            {"name": "Relative", "image": "./scenes/abc/image", "zip": "./scenes/abc/download"},
            {"name": "Absolute", "image": "https://scenes.example.com/scenes/def/image"},
            {"name": "No preview", "image": None},
        ],
    }

    mock_client = AsyncMock()
    mock_client.get.return_value = fake_response
    mock_async_client_cls.return_value = mock_client
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = False

    repo = Repository(
        project_id=default_project.id,
        name="Store",
        url="https://cloud.example.com/api/store/repository.json",
    )
    db.add(repo)
    db.commit()

    await repo.update_templates()
    db.commit()

    by_name = {template["name"]: template for template in repo.templates}
    assert by_name["Relative"]["image"] == "https://cloud.example.com/api/store/scenes/abc/image"
    assert by_name["Relative"]["zip"] == "https://cloud.example.com/api/store/scenes/abc/download"
    assert by_name["Absolute"]["image"] == "https://scenes.example.com/scenes/def/image"
    assert by_name["No preview"]["image"] is None
