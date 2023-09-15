import unittest
from unittest.mock import patch, MagicMock
from flask import json
from app import app, db, models  # Adjust this import as per your project structure
from app.test.base import BaseTestCase

class TestViews(BaseTestCase):

    def setUp(self):
        super().setUp()


    @patch('app.views.models.get_app_configs')
    def test_apps(self, mock_get_app_configs):
        mock_data = [{"name": "app1"}, {"name": "app2"}]
        mock_get_app_configs.return_value = mock_data

        response = self.client.get('/api/apps')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"apps": mock_data})

    @patch('app.views.models.Frame.query')
    def test_frames(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.to_dict.return_value = {"id": 1}
        mock_query.all.return_value = [mock_frame]

        response = self.client.get('/api/frames')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frames": [{"id": 1}]})

    @patch('app.views.models.Frame.query')
    def test_get_frame_found(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.to_dict.return_value = {"id": 1}
        mock_query.get_or_404.return_value = mock_frame

        response = self.client.get('/api/frames/1')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frame": {"id": 1}})

    @patch('app.views.models.Frame.query')
    def test_get_logs(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.logs = [MagicMock(to_dict=lambda: {"id": 1}), MagicMock(to_dict=lambda: {"id": 2})]
        mock_query.get_or_404.return_value = mock_frame

        response = self.client.get('/api/frames/1/logs')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"logs": [{"id": 1}, {"id": 2}]})

    @patch('app.views.requests.get')
    @patch('app.views.models.Frame.query')
    def test_refresh_frame(self, mock_query, mock_requests):
        mock_frame = MagicMock(frame_host="localhost", frame_port=80)
        mock_query.get_or_404.return_value = mock_frame
        mock_response = MagicMock(status_code=200)
        mock_requests.return_value = mock_response

        response = self.client.post('/api/frames/1/refresh')
        self.assertEqual(response.status_code, 200)

    @patch('app.views.models.new_frame')
    def test_new_frame(self, mock_new_frame):
        frame = models.Frame(frame_host='localhost', server_host='localhost', device='web_only')
        mock_new_frame.return_value = frame

        response = self.client.post('/api/frames/new', data={'frame_host': 'localhost', 'server_host': 'localhost'})
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['frame']['frame_host'], 'localhost')
        self.assertEqual(data['frame']['server_host'], 'localhost')
        self.assertEqual(data['frame']['device'], 'web_only')

    @patch('app.views.models.delete_frame')
    def test_delete_frame_route(self, mock_delete_frame):
        mock_delete_frame.return_value = True

        response = self.client.delete('/api/frames/1')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['message'], 'Frame deleted successfully')

    # ... and so on for other routes

if __name__ == '__main__':
    unittest.main()
