import pytest
from unittest.mock import patch
from sqlalchemy.exc import SQLAlchemyError
from app.models import Repository

@pytest.mark.asyncio
async def test_create_repository(async_client, db_session):
    data = {'url': 'http://example.com/repo'}
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 201
    new_repo = db_session.query(Repository).first()
    assert new_repo is not None

@pytest.mark.asyncio
async def test_get_repositories(async_client):
    response = await async_client.get('/api/repositories')
    assert response.status_code == 200
    repositories = response.json()
    assert isinstance(repositories, list)

@pytest.mark.asyncio
async def test_get_repository(async_client, db_session):
    repo = Repository(name='Test Repo', url='http://example.com/repo')
    db_session.add(repo)
    db_session.commit()

    response = await async_client.get(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    repository = response.json()
    assert repository['name'] == 'Test Repo'

@pytest.mark.asyncio
async def test_update_repository(async_client, db_session):
    repo = Repository(name='Test Repo', url='http://example.com/repo')
    db_session.add(repo)
    db_session.commit()

    updated_data = {
        'name': 'Updated Repo',
        'url': 'http://example.com/new_repo'
    }
    response = await async_client.patch(f'/api/repositories/{repo.id}', json=updated_data)
    assert response.status_code == 200
    updated_repo = db_session.query(Repository).get(repo.id)
    assert updated_repo.name == 'Updated Repo'

@pytest.mark.asyncio
async def test_delete_repository(async_client, db_session):
    repo = Repository(name='Test Repo', url='http://example.com/repo')
    db_session.add(repo)
    db_session.commit()

    response = await async_client.delete(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    deleted_repo = db_session.query(Repository).get(repo.id)
    assert deleted_repo is None

@pytest.mark.asyncio
async def test_create_repository_invalid_input(async_client):
    data = {}  # Missing 'url'
    response = await async_client.post('/api/repositories', json=data)
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_get_nonexistent_repository(async_client):
    response = await async_client.get('/api/repositories/9999')
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_update_nonexistent_repository(async_client):
    data = {'name': 'Updated Repo', 'url': 'http://example.com/new_repo'}
    response = await async_client.patch('/api/repositories/9999', json=data)
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_delete_nonexistent_repository(async_client):
    response = await async_client.delete('/api/repositories/9999')
    assert response.status_code == 404

@pytest.fixture
async def no_auth_client():
    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport
    from app.fastapi import app
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest.mark.asyncio
async def test_unauthorized_access(no_auth_client):
    endpoints = [
        ('/api/repositories', 'POST', {'name': 'New Repo', 'url': 'http://example.com/repo'}),
        ('/api/repositories', 'GET', None),
        ('/api/repositories/1', 'GET', None),
        ('/api/repositories/1', 'PATCH', {'name': 'Updated Repo'}),
        ('/api/repositories/1', 'DELETE', None)
    ]
    for endpoint, method, data in endpoints:
        response = await no_auth_client.request(method, endpoint, json=data)
        assert response.status_code == 401

@pytest.mark.asyncio
async def test_get_repositories_exception_handling(async_client, monkeypatch):
    def mock_query_error(*args, **kwargs):
        raise SQLAlchemyError("Database error")

    # Monkeypatch the query to raise an exception
    def mock_query(*args, **kwargs):
        class MockQuery:
            def all(self):
                raise SQLAlchemyError("Database error")
        return MockQuery()

    monkeypatch.setattr("app.api.repositories.db.query", mock_query_error, raising=False)
    # If this doesn't match your code structure, adjust accordingly.
    # Alternatively, patch the endpoint logic directly where the query is made.

    response = await async_client.get('/api/repositories')
    assert response.status_code == 500

@pytest.mark.asyncio
async def test_create_repository_calls_update_templates(async_client, monkeypatch, db_session):
    with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
        data = {'name': 'New Repository', 'url': 'http://example.com/repo'}
        response = await async_client.post('/api/repositories', json=data)
        assert response.status_code == 201
        mock_update_templates.assert_called_once()

@pytest.mark.asyncio
async def test_get_repositories_calls_update_templates(async_client, monkeypatch):
    # If the logic triggers update_templates under certain conditions, test that here.
    # If update_templates isn't always called, you can adapt the test accordingly.
    # For example, if it's called when new samples or gallery repos are created:
    with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
        response = await async_client.get('/api/repositories')
        assert response.status_code == 200
        # Check if update_templates was called depending on your logic
        # If not called, assert not called. If always called, assert called.
        # Adjust this depending on your actual business logic.
        # For now, let's assume no new repo is created => not called
        mock_update_templates.assert_not_called()

@pytest.mark.asyncio
async def test_update_repository_calls_update_templates(async_client, db_session):
    repo = Repository(name='Test Repo', url='http://example.com/repo')
    db_session.add(repo)
    db_session.commit()

    with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
        data = {'name': 'Updated Repo', 'url': 'http://example.com/new_repo'}
        response = await async_client.patch(f'/api/repositories/{repo.id}', json=data)
        assert response.status_code == 200
        mock_update_templates.assert_called_once()
