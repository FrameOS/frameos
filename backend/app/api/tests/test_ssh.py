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
async def test_generate_ssh_keys_error_handling(async_client):
    with patch('cryptography.hazmat.primitives.asymmetric.rsa.generate_private_key') as mock_generate:
        mock_generate.side_effect = Exception("Key generation error")
        response = await async_client.post('/api/generate_ssh_keys')
        assert response.status_code == 500
        # The code: raise HTTPException(status_code=500, detail="Key generation error")
        # => {"detail": "Key generation error"}
        assert response.json()['detail'] == "Key generation error"
