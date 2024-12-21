import pytest
from unittest.mock import patch
from app.models.repository import Repository

@pytest.mark.asyncio
async def test_repository_create(db_session):
    repo = Repository(name="TestRepo", url="http://example.com/repo")
    db_session.add(repo)
    db_session.commit()
    assert repo.id is not None

@pytest.mark.asyncio
@patch("requests.get")
async def test_repository_update_templates(mock_get, db_session):
    # Mock the requests.get call
    mock_get.return_value.status_code = 200
    mock_get.return_value.json.return_value = {
        "name": "My Repo",
        "description": "A sample repository",
        "templates": [{"title": "Template1"}],
    }

    repo = Repository(name="OldName", url="http://example.com/repo")
    db_session.add(repo)
    db_session.commit()

    repo.update_templates()
    db_session.commit()
    assert repo.name == "My Repo"
    assert repo.description == "A sample repository"
    assert len(repo.templates) == 1
