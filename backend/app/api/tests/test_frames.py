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

    def test_api_frames(self):
        response = self.client.get('/api/frames')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"frames": [self.frame.to_dict()]}

    def test_api_frame_get_found(self):
        response = self.client.get(f'/api/frames/{self.frame.id}')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"frame": self.frame.to_dict()}

    def test_api_frame_get_not_found(self):
        response = self.client.get('/api/frames/99999999')  # Use an ID that doesn't exist
        assert response.status_code == 404

    def test_api_frame_get_logs(self):
        log1 = new_log(self.frame.id, 'logtype', "Test log 1")
        log2 = new_log(self.frame.id, 'logtype', "Test log 2")
        response = self.client.get(f'/api/frames/{self.frame.id}/logs')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data == {"logs": [log1.to_dict(), log2.to_dict()]}

    def test_api_frame_get_logs_limit(self):
        for i in range(0, 1010):
            new_log(self.frame.id, 'logtype', "Test log 2")
        response = self.client.get(f'/api/frames/{self.frame.id}/logs')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert len(data['logs']) == 1000

    def test_api_frame_get_image_cached(self):
        redis.set(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image', 'cached_image_data')
        response = self.client.get(f'/api/frames/{self.frame.id}/image?t=-1')
        assert response.status_code == 200
        assert response.data == b'cached_image_data'

    def test_api_frame_get_image_no_cache(self):
        redis.delete(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
        with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
            response = self.client.get(f'/api/frames/{self.frame.id}/image')
            assert response.status_code == 200
            assert response.data == b'image_data'
            cached_image = redis.get(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
            assert cached_image == b'image_data'

    def test_api_frame_get_image_cache_missing(self):
        redis.delete(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
        with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
            # TODO: t=-1 (cached) should be the default, the rest should use t=timestamp to get a fresh copy
            response = self.client.get(f'/api/frames/{self.frame.id}/image?t=-1')
            assert response.status_code == 200
            assert response.data == b'image_data'
            cached_image = redis.get(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
            assert cached_image == b'image_data'

    def test_api_frame_get_image_cache_ignore(self):
        redis.set(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image', 'cached_image_data')
        with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
            response = self.client.get(f'/api/frames/{self.frame.id}/image')
            assert response.status_code == 200
            assert response.data == b'image_data'
            cached_image = redis.get(f'frame:{self.frame.frame_host}:{self.frame.frame_port}:image')
            assert cached_image == b'image_data'

    def test_api_frame_get_image_external_service_error(self):
        self.client.post(f'/api/frames/{self.frame.id}', data={'name': "NoName", "frame_host": "999.999.999.999"})

        with mock.patch('requests.get', return_value=MockResponse(status_code=500)):
            response = self.client.get(f'/api/frames/{self.frame.id}/image?t=-1')
            assert response.status_code == 500
            assert json.loads(response.data) == { "error": "Unable to fetch image" }


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


    def test_api_frame_update_name(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={'name': 'Updated Name'})
        assert response.status_code == 200
        updated_frame = models.Frame.query.get(self.frame.id)
        assert updated_frame.name == 'Updated Name'

    def test_api_frame_update_a_lot(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={
            'name': 'Updated Name',
            'frame_host': 'penguin',
            'ssh_user': 'tux',
            'ssh_pass': 'herring',
            'ssh_port': '2222',
            'server_host': 'walrus',
            'server_port': '89999',
            'device': 'framebuffer',
            'scaling_mode': 'contain',
            'rotate': '90',
            'background_color': 'black',
            'scenes': json.dumps([{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]),
        })
        assert response.status_code == 200
        updated_frame = models.Frame.query.get(self.frame.id)
        assert updated_frame.name == 'Updated Name'
        assert updated_frame.frame_host == 'penguin'
        assert updated_frame.ssh_user == 'tux'
        assert updated_frame.ssh_pass == 'herring'
        assert updated_frame.ssh_port == 2222
        assert updated_frame.server_host == 'walrus'
        assert updated_frame.server_port == 89999
        assert updated_frame.device == 'framebuffer'
        assert updated_frame.scaling_mode == 'contain'
        assert updated_frame.rotate == 90
        assert updated_frame.background_color == 'black'
        assert updated_frame.scenes == [{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]

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

    def test_api_frame_update_invalid_data(self):
        response = self.client.post(f'/api/frames/{self.frame.id}', data={'width': 'invalid'})
        assert response.status_code == 400

    def test_api_frame_update_next_action_restart(self):
        pass

    def test_api_frame_update_next_action_deploy(self):
        pass

    def test_api_frame_new(self):
        response = self.client.post('/api/frames/new', data={'name': 'Frame', 'frame_host': 'localhost', 'server_host': 'localhost'})
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data['frame']['name'] == 'Frame'
        assert data['frame']['frame_host'] == 'localhost'
        assert data['frame']['frame_port'] == 8999
        assert data['frame']['ssh_port'] == 22
        assert data['frame']['server_host'] == 'localhost'
        assert data['frame']['server_port'] == 8999
        assert data['frame']['device'] == 'web_only'

    def test_api_frame_new_parsed(self):
        response = self.client.post('/api/frames/new', data={'name': 'Frame', 'frame_host': 'user:pass@localhost', 'server_host': 'localhost', 'device': 'framebuffer'})
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data['frame']['name'] == 'Frame'
        assert data['frame']['frame_host'] == 'localhost'
        assert data['frame']['frame_port'] == 8999
        assert data['frame']['ssh_port'] == 22
        assert data['frame']['ssh_user'] == 'user'
        assert data['frame']['ssh_pass'] == 'pass'
        assert data['frame']['server_host'] == 'localhost'
        assert data['frame']['server_port'] == 8999
        assert data['frame']['device'] == 'framebuffer'

    def test_api_frame_delete(self):
        def api_length():
            response = self.client.get('/api/frames')
            data = json.loads(response.data)
            return len(data['frames'])

        assert api_length() == 1
        frame = new_frame('Frame', 'localhost', 'localhost')
        assert api_length() == 2
        response = self.client.delete(f'/api/frames/{frame.id}')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert data['message'] == 'Frame deleted successfully'
        assert api_length() == 1

    def test_api_frame_delete_not_found(self):
        response = self.client.delete('/api/frames/99999999')
        assert response.status_code == 404

    def test_api_frames_unauthorized(self):
        pass

    def test_api_frame_get_unauthorized(self):
        pass
