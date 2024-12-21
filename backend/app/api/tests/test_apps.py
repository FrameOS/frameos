# backend/app/api/test/apps.py

import pytest

@pytest.mark.asyncio
async def test_api_apps(async_client):
    """
    Test that /api/apps endpoint returns a list of apps.
    """
    response = await async_client.get('/api/apps')
    data = response.json()
    print(data)
    assert response.status_code == 200, "Expected /api/apps to return status 200"
    assert 'apps' in data, "Response should contain 'apps' key"
    assert len(data['apps']) > 0, "Expected at least one app in the 'apps' dictionary"
    # Check for known apps (example: 'logic/ifElse' is from the sample code)
    assert 'logic/ifElse' in data['apps'], "Expected 'logic/ifElse' to be listed among apps"
    assert 'data/clock' in data['apps'], "Expected 'data/clock' to be listed among apps"


@pytest.mark.asyncio
async def test_api_apps_source(async_client):
    """
    Test that /api/apps/source returns the source code for a given app.
    """
    response = await async_client.get('/api/apps/source?keyword=logic/ifElse')
    data = response.json()
    assert response.status_code == 200, "Expected /api/apps/source to return status 200"
    assert 'app.nim' in data, "Expected 'app.nim' to be part of the returned sources"
    assert 'config.json' in data, "Expected 'config.json' to be part of the returned sources"
    assert 'AppRoot' in data['app.nim'], "Expected 'AppRoot' text within app.nim source"


@pytest.mark.asyncio
async def test_validate_python_frame_source_valid(async_client):
    """
    Test that validating a syntactically correct Python source returns no errors.
    """
    data = {'file': 'test.py', 'source': 'print("Hello World")'}
    response = await async_client.post('/api/apps/validate_source', json=data)
    assert response.status_code == 200, "Expected validate_source endpoint to return status 200"
    errors = response.json().get('errors')
    assert errors == [], "Expected no errors for valid Python code"


@pytest.mark.asyncio
async def test_validate_python_frame_source_invalid(async_client):
    """
    Test that validating an incorrect Python source returns syntax errors.
    """
    data = {'file': 'test.py', 'source': 'print("Hello Wor'}
    response = await async_client.post('/api/apps/validate_source', json=data)
    assert response.status_code == 200, "Expected validate_source endpoint to return status 200"
    errors = response.json().get('errors')
    assert len(errors) > 0, "Expected some errors for invalid Python code"
    # For example, a syntax error message or a line/column number
    first_error = errors[0]
    assert 'error' in first_error, "Expected 'error' key in error response"
    assert 'line' in first_error, "Expected 'line' key in error response"
    assert 'column' in first_error, "Expected 'column' key in error response"
