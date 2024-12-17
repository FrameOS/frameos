import pytest
from unittest.mock import patch

@pytest.mark.asyncio
async def test_generate_ssh_keys(async_client):
    response = await async_client.post('/api/generate_ssh_keys')
    assert response.status_code == 200
    keys = response.json()
    assert 'private' in keys
    assert 'public' in keys

@pytest.mark.asyncio
async def test_unauthorized_access(no_auth_client):
    endpoints = [
        ('/api/settings', 'GET', None),
        ('/api/settings', 'POST', {'some_setting': 'value'}),
        ('/api/generate_ssh_keys', 'POST', None)
    ]
    for endpoint, method, data in endpoints:
        response = await no_auth_client.request(method, endpoint, json=data)
        assert response.status_code == 401, f"Unauthorized access to {endpoint} with method {method}"

@pytest.mark.asyncio
async def test_generate_ssh_keys_error_handling(async_client):
    with patch('cryptography.hazmat.primitives.asymmetric.rsa.generate_private_key') as mock_generate:
        mock_generate.side_effect = Exception("Key generation error")
        response = await async_client.post('/api/generate_ssh_keys')
        assert response.status_code == 500
        error_data = response.json()
        assert 'error' in error_data
        assert error_data['error'] == "Key generation error"
