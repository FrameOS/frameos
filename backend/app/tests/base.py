import unittest

from flask import Flask
from app import create_app, db
from app.models import User
from config import TestConfig

class BaseTestCase(unittest.TestCase):
    app: Flask = None

    @classmethod
    def setUpClass(cls):
        cls.app = create_app(TestConfig)
        cls.client = cls.app.test_client()

    def setUp(self):
        self.app_context = self.app.test_request_context()
        self.app_context.push()
        db.drop_all()
        db.create_all()
        self.create_user("tester", "test@example.com", "testpassword")
        login_response = self.login("tester", "testpassword")
        assert login_response.status_code == 200, (login_response.status_code, login_response.data)

    def tearDown(self):
        self.app_context.pop()

    def create_user(self, username, email, password):
        try:
            user = User(username=username, email=email)
            user.set_password(password)
            db.session.add(user)
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            raise

    def login(self, username, password):
        return self.client.post('/login', data=dict(
            username=username,
            password=password
        ), follow_redirects=True)

    def logout(self):
        return self.client.get('/logout', follow_redirects=True)
