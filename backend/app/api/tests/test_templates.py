import io
import json
import zipfile

import pytest
from app.models.template import Template
from app.utils.versions import current_frameos_version


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
    t1 = Template(project_id=async_client.project_id, name="Template1")
    t2 = Template(project_id=async_client.project_id, name="Template2")
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
    t = Template(project_id=async_client.project_id, name="Exportable", scenes=[], config={})
    db.add(t)
    db.commit()

    response = await async_client.get(f'/api/templates/{t.id}/export')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/zip'
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest_path = next(name for name in archive.namelist() if name.endswith('/template.json'))
        manifest = json.loads(archive.read(manifest_path))
    assert manifest['frameosVersion'] == current_frameos_version()


@pytest.mark.asyncio
async def test_delete_nonexistent_template(async_client):
    response = await async_client.delete('/api/templates/999999')
    assert response.status_code == 404
    assert "Template not found" in response.json()['detail']
