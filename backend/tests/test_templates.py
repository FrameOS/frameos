from app.models.template import Template
from app.models.user import User, pwd_context

def create_user_and_authenticate(client, db_session, email="me@test.com", password="banana"):
    user = User(email=email, password=pwd_context.hash(password))
    db_session.add(user)
    db_session.commit()
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    token = resp.json()["access_token"]
    client.headers.update({"Authorization": f"Bearer {token}"})

def test_create_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    data = {
        'name': 'New Template',
        'description': 'A test template',
        'scenes': [],
        'config': {}
    }
    response = client.post('/api/templates', json=data)
    assert response.status_code == 201
    new_template = db_session.query(Template).filter_by(name='New Template').first()
    assert new_template is not None

def test_get_templates(client, db_session):
    create_user_and_authenticate(client, db_session)
    response = client.get('/api/templates')
    assert response.status_code == 200
    templates = response.json()
    assert isinstance(templates, list)

def test_get_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    template = Template(name='Test Template')
    db_session.add(template)
    db_session.commit()

    response = client.get(f'/api/templates/{template.id}')
    assert response.status_code == 200
    template_data = response.json()
    assert template_data['name'] == 'Test Template'

def test_update_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    template = Template(name='Old Template')
    db_session.add(template)
    db_session.commit()

    data = {'name': 'Updated Template'}
    response = client.patch(f'/api/templates/{template.id}', json=data)
    assert response.status_code == 200
    db_session.refresh(template)
    assert template.name == 'Updated Template'

def test_delete_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    template = Template(name='Test Template')
    db_session.add(template)
    db_session.commit()

    response = client.delete(f'/api/templates/{template.id}')
    assert response.status_code == 200
    deleted_template = db_session.query(Template).get(template.id)
    assert deleted_template is None

def test_unauthorized_access(client):
    endpoints = [
        ('/api/templates', 'POST', {'name': 'New Template'}),
        ('/api/templates', 'GET', None),
        ('/api/templates/1', 'GET', None),
        ('/api/templates/1', 'PATCH', {'name': 'Updated Template'}),
        ('/api/templates/1', 'DELETE', None),
        ('/api/templates/1/image', 'GET', None),
        ('/api/templates/1/export', 'GET', None)
    ]
    for endpoint, method, data in endpoints:
        if method == 'GET':
            resp = client.get(endpoint)
        elif method == 'POST':
            resp = client.post(endpoint, json=data)
        elif method == 'PATCH':
            resp = client.patch(endpoint, json=data)
        elif method == 'DELETE':
            resp = client.delete(endpoint)
        assert resp.status_code == 401

def test_get_nonexistent_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    response = client.get('/api/templates/999999999999')
    assert response.status_code == 404

def test_update_nonexistent_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    data = {'name': 'Nonexistent Template'}
    response = client.patch('/api/templates/999999999999', json=data)
    assert response.status_code == 404

def test_delete_nonexistent_template(client, db_session):
    create_user_and_authenticate(client, db_session)
    response = client.delete('/api/templates/999999999999')
    assert response.status_code == 404
