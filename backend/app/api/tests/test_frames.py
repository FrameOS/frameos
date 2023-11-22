from unittest import mock

from flask import json
from app import models, redis
from app.models import new_frame, new_log
from app.tests.base import BaseTestCase, MockResponse


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


    def test_api_frame_update_scenes_json_format(self):
        frame = self._create_frame()

        valid_scenes_json = json.dumps([{"sceneName": "Scene1"}, {"sceneName": "Scene2"}])
        response = self.client.post(f'/api/frames/{frame.id}', data={'scenes': valid_scenes_json})
        self.assertEqual(response.status_code, 200)
        updated_frame = models.Frame.query.get(frame.id)
        self.assertEqual(updated_frame.scenes, json.loads(valid_scenes_json))

        invalid_scenes_json = "Not a valid JSON"
        response = self.client.post(f'/api/frames/{frame.id}', data={'scenes': invalid_scenes_json})
        self.assertEqual(response.status_code, 400)
        error_data = json.loads(response.data)
        self.assertIn('error', error_data)
        self.assertIn('Invalid input', error_data['error'])

    def test_api_frames_unauthorized(self):
        pass

    def test_api_frame_get_unauthorized(self):
        pass

    def test_get_frame_not_found(self):
        response = self.client.get('/api/frames/9999')  # Use an ID that doesn't exist
        assert response.status_code == 404

    def test_delete_frame_not_found(self):
        response = self.client.delete('/api/frames/9999')
        assert response.status_code == 404

    def test_get_image_last_image(self):
        redis.set(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image', 'cached_image_data')
        response = self.client.get(f'/api/frames/{self.frame.id}/image?t=-1')
        assert response.status_code == 200
        assert response.data == b'cached_image_data'

    def test_get_image_external_service_error(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={'name': "NoName", "frame_host": "999.999.999.999"})

        with mock.patch('requests.get', return_value=MockResponse(status_code=500)):
            response = self.client.get(f'/api/frames/{self.frame.id}/image?t=-1')
            assert response.status_code == 500
            assert json.loads(response.data) == { "error": "Unable to fetch image" }

    def test_get_image_redis_cache_scenario(self):
        # Ensure the cache is empty initially
        redis.delete(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
        # Mock external service response
        with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
            response = self.client.get(f'/api/frames/{self.frame.id}/image')
            assert response.status_code == 200
            assert response.data == b'image_data'
            # Check if image is cached now
            cached_image = redis.get(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
            assert cached_image == b'image_data'

    def test_api_frame_render_event_success(self):
        with mock.patch('requests.get', return_value=MockResponse(status_code=200)):
            response = self.client.post(f'/api/frames/{self.frame.id}/event/render')
            assert response.status_code == 200

    def test_api_frame_render_event_failure(self):
        with mock.patch('requests.get', return_value=MockResponse(status_code=500)):
            response = self.client.post(f'/api/frames/{self.frame.id}/event/render')
            assert response.status_code == 500

    def test_api_frame_reset_event(self):
        pass

    def test_api_frame_restart_event(self):
        pass

    def test_api_frame_deploy_event(self):
        pass

    def test_api_frame_update_success(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={'name': 'Updated Name'})
        assert response.status_code == 200
        updated_frame = models.Frame.query.get(self.frame.id)
        assert updated_frame.name == 'Updated Name'

    def test_api_frame_update_invalid_data(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={'width': 'invalid'})
        assert response.status_code == 400

    def test_api_frame_update_with_next_action(self):
        pass
