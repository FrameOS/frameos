import json
from app.models import Template
from app.tests.base import BaseTestCase

class TestTemplateAPI(BaseTestCase):
    def test_create_template(self):
        data = {
            'name': 'New Template',
            'description': 'A test template',
            'scenes': [],
            'config': {}
        }
        response = self.client.post('/api/templates', json=data)
        self.assertEqual(response.status_code, 201)
        new_template = self.db.query(Template).filter_by(name='New Template').first()
        self.assertIsNotNone(new_template)

    def test_get_templates(self):
        response = self.client.get('/api/templates')
        self.assertEqual(response.status_code, 200)
        templates = json.loads(response.data)
        self.assertIsInstance(templates, list)

    def test_get_template(self):
        template = Template(name='Test Template')
        self.db.add(template)
        self.db.commit()

        response = self.client.get(f'/api/templates/{template.id}')
        self.assertEqual(response.status_code, 200)
        template_data = json.loads(response.data)
        self.assertEqual(template_data['name'], 'Test Template')


    def test_update_template(self):
        template = Template(name='Old Template')
        self.db.add(template)
        self.db.commit()

        data = {'name': 'Updated Template'}
        response = self.client.patch(f'/api/templates/{template.id}', json=data)
        self.assertEqual(response.status_code, 200)
        updated_template = self.db.query(Template).get(template.id)
        self.assertEqual(updated_template.name, 'Updated Template')

    def test_delete_template(self):
        template = Template(name='Test Template')
        self.db.add(template)
        self.db.commit()

        response = self.client.delete(f'/api/templates/{template.id}')
        self.assertEqual(response.status_code, 200)
        deleted_template = self.db.query(Template).get(template.id)
        self.assertIsNone(deleted_template)

    # def test_get_template_image(self):
    #     with open('test_image.jpg', 'rb') as img_file:
    #         image_data = img_file.read()
    #     template = Template(name='Test Template', image=image_data)
    #     self.db.add(template)
    #     self.db.commit()
    #
    #     response = self.client.get(f'/api/templates/{template.id}/image')
    #     self.assertEqual(response.status_code, 200)
    #     self.assertEqual(response.mimetype, 'image/jpeg')

    # def test_export_template(self):
    #     template = Template(name='Test Template', scenes=[], config={})
    #     self.db.add(template)
    #     self.db.commit()
    #
    #     response = self.client.get(f'/api/templates/{template.id}/export')
    #     self.assertEqual(response.status_code, 200)
    #     self.assertEqual(response.mimetype, 'application/zip')

    def test_unauthorized_access(self):
        self.logout()

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
            response = self.client.open(endpoint, method=method, json=data)
            self.assertEqual(response.status_code, 401)


    # def test_create_template_invalid_input(self):
    #     data = {}  # Empty data
    #     response = self.client.post('/api/templates', json=data)
    #     self.assertEqual(response.status_code, 400)

    def test_get_nonexistent_template(self):
        response = self.client.get('/api/templates/999999999999')  # Non-existent ID
        self.assertEqual(response.status_code, 404)

    def test_update_nonexistent_template(self):
        data = {'name': 'Nonexistent Template'}
        response = self.client.patch('/api/templates/999999999999', json=data)
        self.assertEqual(response.status_code, 404)

    def test_delete_nonexistent_template(self):
        response = self.client.delete('/api/templates/999999999999')
        self.assertEqual(response.status_code, 404)
