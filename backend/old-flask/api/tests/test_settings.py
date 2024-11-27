import json
from app.tests.base import BaseTestCase

class TestSettingsAPI(BaseTestCase):
    def test_get_settings(self):
        # Test the GET /settings endpoint
        response = self.client.get('/api/settings')
        self.assertEqual(response.status_code, 200)
        settings = json.loads(response.data)
        self.assertIsInstance(settings, dict)

    def test_set_settings(self):
        # Test the POST /settings endpoint
        data = {'some_setting': 'new_value'}
        response = self.client.post('/api/settings', json=data)
        self.assertEqual(response.status_code, 200)
        updated_settings = json.loads(response.data)
        self.assertEqual(updated_settings.get('some_setting'), 'new_value')

    def test_set_settings_no_payload(self):
        # Test the POST /settings endpoint with no payload
        response = self.client.post('/api/settings', json={})
        self.assertEqual(response.status_code, 400)

    def test_unauthorized_access(self):
        self.logout()

        endpoints = [
            ('/api/settings', 'GET', None),
            ('/api/settings', 'POST', {'some_setting': 'value'}),
        ]
        for endpoint, method, data in endpoints:
            response = self.client.open(endpoint, method=method, json=data)
            self.assertEqual(response.status_code, 401)
