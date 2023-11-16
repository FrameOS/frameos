import unittest
from unittest.mock import patch
from flask import json
from app.tests.base import BaseTestCase

class TestViews(BaseTestCase):

    def setUp(self):
        super().setUp()

    def test_apps(self):
        response = self.client.get('/api/apps')
        data = json.loads(response.data)
        assert response.status_code == 200
        assert 'apps' in data
        assert len(data['apps']) > 0
        assert 'boilerplate' in data['apps']
        assert 'clock' in data['apps']
