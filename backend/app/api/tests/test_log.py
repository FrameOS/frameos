from app.tests.base import BaseTestCase
from app.models import new_frame, update_frame, Log


class TestLogAPI(BaseTestCase):
    def init_tests(self):
        self.frame = new_frame('Frame', 'localhost', 'localhost')
        self.frame.server_api_key = 'testkey'
        update_frame(self.frame)
        assert Log.query.filter_by(frame=self.frame).count() == 0

    def test_api_log_single_entry(self):
        headers = {'Authorization': 'Bearer testkey'}
        data = {'log': {'event': 'log', 'message': 'banana'}}
        response = self.client.post('/api/log', json=data, headers=headers)
        assert response.status_code == 200
        assert Log.query.filter_by(frame=self.frame).count() == 1


    def test_api_log_multiple_entries(self):
        headers = {'Authorization': 'Bearer testkey'}
        logs = [{'event': 'log', 'message': 'banana'}, {'event': 'log', 'message': 'pineapple'}]
        data = {'logs': logs}
        response = self.client.post('/api/log', json=data, headers=headers)
        assert response.status_code == 200
        assert Log.query.filter_by(frame=self.frame).count() == 2

    def test_api_log_no_data(self):
        # Test the /log endpoint with no data
        headers = {'Authorization': 'Bearer testkey'}
        response = self.client.post('/api/log', json={}, headers=headers)
        assert response.status_code == 200

    def test_api_log_bad_key(self):
        headers = {'Authorization': 'Bearer wasabi'}
        data = {'log': {'event': 'log', 'message': 'banana'}}
        response = self.client.post('/api/log', json=data, headers=headers)
        assert response.status_code == 401

    def test_api_log_no_key(self):
        data = {'log': {'event': 'log', 'message': 'banana'}}
        response = self.client.post('/api/log', json=data)
        assert response.status_code == 401
        assert Log.query.filter_by(frame=self.frame).count() == 0

    def test_api_log_limits(self):
        headers = {'Authorization': 'Bearer testkey'}
        data = {'logs': [{'event': 'log', 'message': 'banana'}] * 1200}
        response = self.client.post('/api/log', json=data, headers=headers)
        assert response.status_code == 200
        assert Log.query.filter_by(frame=self.frame).count() == 1100

        data = {'logs': [{'event': 'log', 'message': 'banana'}] * 50}
        self.client.post('/api/log', json=data, headers=headers)
        assert Log.query.filter_by(frame=self.frame).count() == 1050

        data = {'logs': [{'event': 'log', 'message': 'banana'}] * 40}
        self.client.post('/api/log', json=data, headers=headers)
        assert Log.query.filter_by(frame=self.frame).count() == 1090

        data = {'logs': [{'event': 'log', 'message': 'banana'}] * 30}
        self.client.post('/api/log', json=data, headers=headers)
        assert Log.query.filter_by(frame=self.frame).count() == 1020
