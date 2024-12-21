import pytest

@pytest.mark.asyncio
async def test_get_settings(async_client):
    response = await async_client.get('/api/settings')
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, dict)

@pytest.mark.asyncio
async def test_set_settings(async_client):
    payload = {"some_setting": "hello"}
    response = await async_client.post('/api/settings', json=payload)
    assert response.status_code == 200
    updated = response.json()
    assert updated["some_setting"] == "hello"

@pytest.mark.asyncio
async def test_set_settings_no_payload(async_client):
    response = await async_client.post('/api/settings', json={})
    assert response.status_code == 400
    assert response.json()['detail'] == "No JSON payload received"
