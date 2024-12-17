import pytest
from app.models import Template

@pytest.mark.asyncio
async def test_create_template(async_client, db_session):
    data = {
        'name': 'New Template',
        'description': 'A test template',
        'scenes': [],
        'config': {}
    }
    response = await async_client.post('/api/templates', json=data)
    assert response.status_code == 201
    new_template = db_session.query(Template).filter_by(name='New Template').first()
    assert new_template is not None
    assert new_template.description == 'A test template'

@pytest.mark.asyncio
async def test_get_templates(async_client, db_session):
    # Optionally, add some templates to the database
    template1 = Template(name='Template 1', description='First template')
    template2 = Template(name='Template 2', description='Second template')
    db_session.add_all([template1, template2])
    db_session.commit()

    response = await async_client.get('/api/templates')
    assert response.status_code == 200
    templates = response.json()
    assert isinstance(templates, list)
    assert len(templates) >= 2  # Depending on existing templates
    names = [t['name'] for t in templates]
    assert 'Template 1' in names
    assert 'Template 2' in names

@pytest.mark.asyncio
async def test_get_template(async_client, db_session):
    template = Template(name='Test Template', description='A test template')
    db_session.add(template)
    db_session.commit()

    response = await async_client.get(f'/api/templates/{template.id}')
    assert response.status_code == 200
    template_data = response.json()
    assert template_data['name'] == 'Test Template'
    assert template_data['description'] == 'A test template'

@pytest.mark.asyncio
async def test_update_template(async_client, db_session):
    template = Template(name='Old Template', description='Old description')
    db_session.add(template)
    db_session.commit()

    data = {'name': 'Updated Template', 'description': 'Updated description'}
    response = await async_client.patch(f'/api/templates/{template.id}', json=data)
    assert response.status_code == 200
    updated_template = db_session.query(Template).get(template.id)
    assert updated_template.name == 'Updated Template'
    assert updated_template.description == 'Updated description'

@pytest.mark.asyncio
async def test_delete_template(async_client, db_session):
    template = Template(name='Test Template', description='To be deleted')
    db_session.add(template)
    db_session.commit()

    response = await async_client.delete(f'/api/templates/{template.id}')
    assert response.status_code == 200
    deleted_template = db_session.query(Template).get(template.id)
    assert deleted_template is None

@pytest.mark.asyncio
async def test_unauthorized_access(no_auth_client):
    endpoints = [
        ('/api/templates', 'POST', {'name': 'New Template', 'description': 'Desc', 'scenes': [], 'config': {}}),
        ('/api/templates', 'GET', None),
        ('/api/templates/1', 'GET', None),
        ('/api/templates/1', 'PATCH', {'name': 'Updated Template'}),
        ('/api/templates/1', 'DELETE', None),
        ('/api/templates/1/image', 'GET', None),
        ('/api/templates/1/export', 'GET', None)
    ]
    for endpoint, method, data in endpoints:
        response = await no_auth_client.request(method, endpoint, json=data)
        assert response.status_code == 401, f"Unauthorized access to {endpoint} with method {method}"

@pytest.mark.asyncio
async def test_get_nonexistent_template(async_client):
    response = await async_client.get('/api/templates/999999999999')  # Non-existent ID
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_update_nonexistent_template(async_client):
    data = {'name': 'Nonexistent Template'}
    response = await async_client.patch('/api/templates/999999999999', json=data)
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_delete_nonexistent_template(async_client):
    response = await async_client.delete('/api/templates/999999999999')
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_export_template(async_client, db_session):
    template = Template(name='Export Template', description='To be exported', scenes=[], config={})
    db_session.add(template)
    db_session.commit()

    response = await async_client.get(f'/api/templates/{template.id}/export')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/zip'
    assert 'attachment; filename=' in response.headers['Content-Disposition']

@pytest.mark.asyncio
async def test_get_template_image(async_client, db_session):
    # Create a template with an image
    image_data = b'test_image_data'
    template = Template(name='Image Template', image=image_data)
    db_session.add(template)
    db_session.commit()

    response = await async_client.get(f'/api/templates/{template.id}/image')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/jpeg'
    assert response.content == image_data
