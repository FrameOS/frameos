import pytest

@pytest.mark.asyncio
async def test_get_settings(async_client):
    response = await async_client.get('/api/settings')
    assert response.status_code == 200
    settings = response.json()
    assert isinstance(settings, dict)

@pytest.mark.asyncio
async def test_set_settings(async_client):
    data = {'some_setting': 'new_value'}
    response = await async_client.post('/api/settings', json=data)
    assert response.status_code == 200
    updated_settings = response.json()
    assert updated_settings.get('some_setting') == 'new_value'

@pytest.mark.asyncio
async def test_set_settings_no_payload(async_client):
    response = await async_client.post('/api/settings', json={})
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_unauthorized_access_settings(no_auth_client):
    endpoints = [
        ('/api/settings', 'GET', None),
        ('/api/settings', 'POST', {'some_setting': 'value'}),
    ]
    for endpoint, method, data in endpoints:
        response = await no_auth_client.request(method, endpoint, json=data)
        assert response.status_code == 401
