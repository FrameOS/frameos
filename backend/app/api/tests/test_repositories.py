import pytest
from app.models import Repository

@pytest.mark.asyncio
async def test_create_repository(async_client, db_session):
    data = {'url': 'http://example.com/repo.json'}
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 201
    repo = db_session.query(Repository).first()
    assert repo is not None
    assert repo.url == 'http://example.com/repo.json'

@pytest.mark.asyncio
async def test_create_repository_invalid_input(async_client):
    # Missing URL
    data = {}
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 422
    assert "Missing URL" in response.json()['detail']

@pytest.mark.asyncio
async def test_get_repositories(async_client, db_session):
    # Possibly your code also ensures the "samples" and "gallery" repos are created
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    # Should be a list
    repos = response.json()
    assert isinstance(repos, list)

@pytest.mark.asyncio
async def test_get_repository(async_client, db_session):
    repo = Repository(name="Test Repo", url="http://example.com/test.json")
    db_session.add(repo)
    db_session.commit()
    response = await async_client.get(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    data = response.json()
    assert data['name'] == 'Test Repo'

@pytest.mark.asyncio
async def test_update_repository(async_client, db_session):
    repo = Repository(name="Old Repo", url="http://example.com/old.json")
    db_session.add(repo)
    db_session.commit()

    updated_data = {"name": "Updated Repo", "url": "http://example.com/updated.json"}
    response = await async_client.patch(f'/api/repositories/{repo.id}', json=updated_data)
    assert response.status_code == 200
    db_session.refresh(repo)
    assert repo.name == "Updated Repo"
    assert repo.url == "http://example.com/updated.json"

@pytest.mark.asyncio
async def test_delete_repository(async_client, db_session):
    repo = Repository(name="DeleteMe", url="http://example.com/delete.json")
    db_session.add(repo)
    db_session.commit()

    response = await async_client.delete(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    assert response.json()['message'] == "Repository deleted successfully"
    assert db_session.get(Repository, repo.id) is None

@pytest.mark.asyncio
async def test_delete_nonexistent_repository(async_client):
    response = await async_client.delete('/api/repositories/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == "Repository not found"
