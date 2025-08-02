import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from app.models.repository import Repository

@pytest.mark.asyncio
async def test_repository_create(db):
    repo = Repository(name="TestRepo", url="http://example.com/repo")
    db.add(repo)
    db.commit()
    assert repo.id is not None


@pytest.mark.asyncio
@patch("app.models.repository.httpx.AsyncClient")   # ➊ patch the *class*
async def test_repository_update_templates(mock_async_client_cls, db):
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

    repo = Repository(name="OldName", url="http://example.com/repo")
    db.add(repo)
    db.commit()

    await repo.update_templates()
    db.commit()

    assert repo.name == "My Repo"
    assert repo.description == "A sample repository"
    assert len(repo.templates) == 1

    mock_client.get.assert_awaited_once_with("http://example.com/repo", timeout=10)