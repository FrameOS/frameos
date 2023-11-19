import unittest
from flask import json
from app import models
from app.models import new_frame, new_log
from app.tests.base import BaseTestCase

class TestFrames(BaseTestCase):
    @classmethod
    def setUpClass(cls):
        super(TestFrames, cls).setUpClass()
        cls.frame = cls._create_frame()

    @classmethod
    def tearDownClass(cls):
        # Clean up code (if needed)
        super(TestFrames, cls).tearDownClass()

    @staticmethod
    def _create_frame() -> models.Frame:
        return new_frame('Frame', 'localhost', 'localhost')

    def test_frames(self):
        response = self.client.get('/api/frames')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frames": [self.frame.to_dict()]})

    def test_get_frame_found(self):
        response = self.client.get(f'/api/frames/{self.frame.id}')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frame": self.frame.to_dict()})

    def test_get_logs(self):
        log1 = new_log(self.frame.id, 'logtype', "Test log 1")
        log2 = new_log(self.frame.id, 'logtype', "Test log 2")
        response = self.client.get(f'/api/frames/{self.frame.id}/logs')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"logs": [log1.to_dict(), log2.to_dict()]})

    def test_new_frame(self):
        response = self.client.post('/api/frames/new', data={'name': 'Frame', 'frame_host': 'localhost', 'server_host': 'localhost'})
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['frame']['name'], 'Frame')
        self.assertEqual(data['frame']['frame_host'], 'localhost')
        self.assertEqual(data['frame']['server_host'], 'localhost')
        self.assertEqual(data['frame']['device'], 'web_only')

    def test_delete_frame_route(self):
        frame = new_frame('Frame', 'localhost', 'localhost')
        response = self.client.delete(f'/api/frames/{frame.id}')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['message'], 'Frame deleted successfully')

    # Stub methods for the new test cases
    # ...


import unittest
from flask import json
from app import models
from app.models import new_frame, new_log
from app.tests.base import BaseTestCase

class TestFrames(BaseTestCase):

    def setUp(self):
        super().setUp()
        self.frame = self._create_frame()

    def _create_frame(self) -> models.Frame:
        frame = new_frame('Frame', 'localhost', 'localhost')
        return frame

    def test_frames(self):
        response = self.client.get('/api/frames')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"frames": [self.frame.to_dict()]}

    def test_get_frame_found(self):
        response = self.client.get(f'/api/frames/{self.frame.id}')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"frame": self.frame.to_dict()}

    def test_get_logs(self):
        log1 = new_log(self.frame.id, 'logtype', "Test log 1")
        log2 = new_log(self.frame.id, 'logtype', "Test log 2")
        response = self.client.get(f'/api/frames/{self.frame.id}/logs')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"logs": [log1.to_dict(), log2.to_dict()]}

    def test_new_frame(self):
        response = self.client.post('/api/frames/new', data={'name': 'Frame', 'frame_host': 'localhost', 'server_host': 'localhost'})
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data['frame']['name'] == 'Frame'
        assert data['frame']['frame_host'] == 'localhost'
        assert data['frame']['server_host'] == 'localhost'
        assert data['frame']['device'] == 'web_only'

    def test_delete_frame_route(self):
        frame = new_frame('Frame', 'localhost', 'localhost')
        response = self.client.delete(f'/api/frames/{frame.id}')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data['message'] == 'Frame deleted successfully'

    def test_api_frames_unauthorized(self):
        pass

    def test_api_frame_get_unauthorized(self):
        pass

    def test_get_frame_not_found(self):
        pass

    def test_delete_frame_not_found(self):
        pass

    def test_get_image_last_image(self):
        pass

    def test_get_image_external_service_error(self):
        pass

    def test_get_image_redis_cache_scenario(self):
        pass

    def test_api_frame_render_event_success(self):
        pass

    def test_api_frame_render_event_failure(self):
        pass

    def test_api_frame_reset_event(self):
        pass

    def test_api_frame_restart_event(self):
        pass

    def test_api_frame_deploy_event(self):
        pass

    def test_api_frame_update_success(self):
        pass

    def test_api_frame_update_invalid_data(self):
        pass

    def test_api_frame_update_with_next_action(self):
        pass
