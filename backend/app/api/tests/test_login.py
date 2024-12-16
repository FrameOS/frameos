from app.tests.base import BaseTestCase
from app.models import User


class TestLogin(BaseTestCase):
    def init_user(self):
        self.user = User(email='me@test.com')
        self.user.set_password('banana')
        self.db.add(self.user)
        self.db.commit()

    def test_login_valid(self):
        data = {'email': 'me@test.com', 'password': 'banana'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 200

    def test_login_invalid_user(self):
        data = {'email': 'notfound', 'password': 'banana'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 401

    def test_login_invalid_pass(self):
        data = {'email': 'me@test.com', 'password': 'notvalid'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 401

    def test_post_login_access(self):
        # pre login
        response = self.client.get('/api/frames')
        assert response.status_code == 401
        assert response.json == {"error": "Unauthorized"}

        # login
        data = {'email': 'me@test.com', 'password': 'banana'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 200

        # post login
        response = self.client.get('/api/frames')
        assert response.status_code == 200
        assert response.json == {"frames": []}

        # logout
        response = self.client.post('/api/logout')
        assert response.status_code == 200

        # post logout
        response = self.client.get('/api/frames')
        assert response.status_code == 401
        assert response.json == {"error": "Unauthorized"}
