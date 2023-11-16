import unittest
from unittest.mock import patch
from flask import json
from app.tests.base import BaseTestCase

class TestViews(BaseTestCase):

    def setUp(self):
        super().setUp()

    @patch('app.models.apps.get_app_configs')
    def test_apps(self, mock_get_app_configs):
        mock_data = [{"name": "app1"}, {"name": "app2"}]
        mock_get_app_configs.return_value = mock_data

        response = self.client.get('/api/apps')
        data = json.loads(response.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data, {"apps": mock_data})

# if __name__ == '__main__':
#     unittest.main()
