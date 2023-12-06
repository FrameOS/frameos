from app import db
from app.tests.base import BaseTestCase
from app.models import User


class TestLogin(BaseTestCase):
    def init_user(self):
        self.user = User(username='test', email='me@test.com')
        self.user.set_password('banana')
        db.session.add(self.user)
        db.session.commit()

    def test_login_valid(self):
        data = {'username': 'test', 'password': 'banana'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 200

    def test_login_invalid_user(self):
        data = {'username': 'notfound', 'password': 'banana'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 401

    def test_login_invalid_pass(self):
        data = {'username': 'test', 'password': 'notvalid'}
        response = self.client.post('/api/login', json=data)
        assert response.status_code == 401

    def test_post_login_access(self):
        # pre login
        response = self.client.get('/api/frames')
        assert response.status_code == 401
        assert response.json == {"error": "Unauthorized"}

        # login
        data = {'username': 'test', 'password': 'banana'}
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
