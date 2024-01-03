from flask import json
from app.tests.base import BaseTestCase

class TestApps(BaseTestCase):

    def test_api_apps(self):
        response = self.client.get('/api/apps')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert 'apps' in data
        assert len(data['apps']) > 0
        assert 'breakIfRendering' in data['apps']
        assert 'clock' in data['apps']

    def test_api_apps_source(self):
        response = self.client.get('/api/apps/source/code')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert 'app.nim' in data
        assert 'config.json' in data
        assert 'FrameConfig' in data['app.nim']

    def test_validate_python_frame_source_python(self):
        data = {'file': 'test.py', 'source': 'print("Hello World")'}
        response = self.client.post('/api/apps/validate_source', json=data)
        assert response.status_code == 200
        assert json.loads(response.data) == {"errors": []}

    def test_validate_python_frame_source_python_errors(self):
        data = {'file': 'test.py', 'source': 'print("Hello Wor'}
        response = self.client.post('/api/apps/validate_source', json=data)
        assert response.status_code == 200
        assert len(json.loads(response.data).get('errors')) > 0
