import unittest
from app import db, app
from app.models import User

class BaseTestCase(unittest.TestCase):

    def setUp(self):
        app.config['TESTING'] = True
        self.client = app.test_client()
        self.app_context = app.app_context()
        self.app_context.push()
        db.drop_all()
        db.create_all()
        self.create_user_and_login()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.app_context.pop()

    def create_user_and_login(self):
        user = User(username="tester", email="test@example.com")
        user.set_password("testpassword")
        db.session.add(user)
        db.session.commit()
        self.login('tester', 'testpassword')

    def login(self, username, password):
        return self.client.post('/api/login', data=dict(
            username=username,
            password=password
        ), follow_redirects=True)

    def logout(self):
        return self.client.get('/logout', follow_redirects=True)
