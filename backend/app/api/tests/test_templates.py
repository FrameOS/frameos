import json
import pytest
from app.models.template import Template

@pytest.mark.asyncio
async def test_create_template(async_client, db):
    payload = {
        "name": "New Template",
        "description": "A test template",
        "scenes": json.dumps([]),
        "config": json.dumps({}),
    }
    response = await async_client.post(
        "/api/templates",
        data=payload,
    )
    # If your endpoint returns 200 or 201, pick one:
    assert response.status_code == 201 or response.status_code == 200
    data = response.json()
    # If the code returns the new Template as dict, check it:
    if isinstance(data, dict) and 'name' in data:
        assert data['name'] == 'New Template'
    # else if your code returns e.g. { "id": "...", "name": "...", ... } do that check.

@pytest.mark.asyncio
async def test_get_templates(async_client, db):
    # Insert a couple
    t1 = Template(name="Template1")
    t2 = Template(name="Template2")
    db.add_all([t1, t2])
    db.commit()

    response = await async_client.get('/api/templates')
    assert response.status_code == 200
    templates = response.json()
    assert isinstance(templates, list)
    assert len(templates) >= 2

@pytest.mark.asyncio
async def test_get_nonexistent_template(async_client):
    response = await async_client.get('/api/templates/999999')
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_export_template(async_client, db):
    t = Template(name="Exportable", scenes=[], config={})
    db.add(t)
    db.commit()

    response = await async_client.get(f'/api/templates/{t.id}/export')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/zip'

@pytest.mark.asyncio
async def test_delete_nonexistent_template(async_client):
    response = await async_client.delete('/api/templates/999999')
    assert response.status_code == 404
    assert "Template not found" in response.json()['detail']
