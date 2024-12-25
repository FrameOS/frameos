import pytest
from app.models.template import Template


@pytest.mark.asyncio
async def test_create_template(async_client, db):
    payload = {
        "name": "New Template",
        "description": "A test template",
        "scenes": [],
        "config": {},
    }
    # Post JSON (the same style as your fetch call):
    response = await async_client.post(
        "/api/templates",
        json=payload,
    )
    # Should return 201 on create
    assert response.status_code == 201
    data = response.json()
    assert isinstance(data, dict)
    assert data.get('name') == 'New Template'


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
    assert len(templates) >= 2  # We added at least 2


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
