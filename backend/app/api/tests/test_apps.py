import pytest

@pytest.mark.asyncio
async def test_api_apps(async_client):
    response = await async_client.get('/api/apps')
    data = response.json()
    assert response.status_code == 200
    assert 'apps' in data
    assert len(data['apps']) > 0
    assert 'logic/ifElse' in data['apps']
    assert 'data/clock' in data['apps']

@pytest.mark.asyncio
async def test_api_apps_source(async_client):
    response = await async_client.get('/api/apps/source?keyword=logic/ifElse')
    data = response.json()
    assert response.status_code == 200
    assert 'app.nim' in data
    assert 'config.json' in data
    assert 'AppRoot' in data['app.nim']

@pytest.mark.asyncio
async def test_validate_python_frame_source_python(async_client):
    data = {'file': 'test.py', 'source': 'print("Hello World")'}
    response = await async_client.post('/api/apps/validate_source', json=data)
    assert response.status_code == 200
    assert response.json() == {"errors": []}

@pytest.mark.asyncio
async def test_validate_python_frame_source_python_errors(async_client):
    data = {'file': 'test.py', 'source': 'print("Hello Wor'}
    response = await async_client.post('/api/apps/validate_source', json=data)
    assert response.status_code == 200
    errors = response.json().get('errors')
    assert len(errors) > 0
