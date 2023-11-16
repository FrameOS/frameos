import unittest
from unittest.mock import patch, MagicMock
from flask import json
from app import models
from app.models import new_frame
from app.tests.base import BaseTestCase

class TestViews(BaseTestCase):

    def setUp(self):
        super().setUp()

    @patch('app.models.frame.Frame.query')
    def test_frames(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.to_dict.return_value = {"id": 1}
        mock_query.all.return_value = [mock_frame]

        response = self.client.get('/api/frames')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frames": [{"id": 1}]})

    @patch('app.models.frame.Frame.query')
    def test_get_frame_found(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.to_dict.return_value = {"id": 1}
        mock_query.get_or_404.return_value = mock_frame

        response = self.client.get('/api/frames/1')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"frame": {"id": 1}})

    @patch('app.models.frame.Frame.query')
    def test_get_logs(self, mock_query):
        mock_frame = MagicMock()
        mock_frame.logs = [MagicMock(to_dict=lambda: {"id": 1}), MagicMock(to_dict=lambda: {"id": 2})]
        mock_query.get_or_404.return_value = mock_frame

        response = self.client.get('/api/frames/1/logs')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"logs": [{"id": 1}, {"id": 2}]})

    @patch('app.api.frames.requests.get')
    @patch('app.models.frame.Frame.query')
    def test_refresh_frame(self, mock_query, mock_requests):
        mock_frame = MagicMock(frame_host="localhost", frame_port=80)
        mock_query.get_or_404.return_value = mock_frame
        mock_response = MagicMock(status_code=200)
        mock_requests.return_value = mock_response

        response = self.client.post('/api/frames/1/event/render')
        self.assertEqual(response.status_code, 200)

    @patch('app.models.frame.new_frame')
    def test_new_frame(self, mock_new_frame):
        frame = models.Frame(frame_host='localhost', server_host='localhost', device='web_only')
        mock_new_frame.return_value = frame

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
