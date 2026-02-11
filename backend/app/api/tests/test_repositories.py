import json
import pytest
from app.models import Repository
from app.models.user import User
from sqlalchemy.exc import InvalidRequestError

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
async def test_get_repository(async_client, db):
    repo = Repository(name="Test Repo", url="http://example.com/test.json")
    db.add(repo)
    db.commit()
    response = await async_client.get(f'/api/repositories/{repo.id}')
    assert response.status_code == 200
    data = response.json()
    assert data['name'] == 'Test Repo'

@pytest.mark.asyncio
async def test_update_repository(async_client, db):
    repo = Repository(name="Old Repo", url="http://example.com/old.json")
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
    repo = Repository(name="DeleteMe", url="http://example.com/delete.json")
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
