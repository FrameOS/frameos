import json
from unittest.mock import patch
from app.tests.base import BaseTestCase

class TestSettingsAPI(BaseTestCase):

    def setUp(self):
        super().setUp()

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

    def test_generate_ssh_keys(self):
        # Test the POST /generate_ssh_keys endpoint
        response = self.client.post('/api/generate_ssh_keys')
        self.assertEqual(response.status_code, 200)
        keys = json.loads(response.data)
        self.assertIn('private', keys)
        self.assertIn('public', keys)

    def test_unauthorized_access(self):
        self.logout()

        endpoints = [
            ('/api/settings', 'GET', None),
            ('/api/settings', 'POST', {'some_setting': 'value'}),
            ('/api/generate_ssh_keys', 'POST', None)
        ]
        for endpoint, method, data in endpoints:
            response = self.client.open(endpoint, method=method, json=data)
            self.assertEqual(response.status_code, 401)

    def test_generate_ssh_keys_error_handling(self):
        # Simulate an error during key generation
        with patch('cryptography.hazmat.primitives.asymmetric.rsa.generate_private_key') as mock_generate:
            mock_generate.side_effect = Exception("Key generation error")
            response = self.client.post('/api/generate_ssh_keys')
            self.assertEqual(response.status_code, 500)

