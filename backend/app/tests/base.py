import secrets
import unittest

from flask import Flask
from app.flask import create_app
from app.models import User
from app.config import TestConfig
from sqlalchemy.orm import Session
from ..database import SessionLocal

class BaseTestCase(unittest.TestCase):
    app: Flask
    db: Session

    @classmethod
    def setUpClass(cls):
        cls.app = create_app(TestConfig)
        cls.client = cls.app.test_client()

    def setUp(self):
        self.app_context = self.app.test_request_context()
        self.app_context.push()
        self.db = SessionLocal()
        self.app.config['SECRET_KEY'] = secrets.token_hex(32)
        self.init_user()
        self.init_tests()

    def tearDown(self):
        self.db.close()
        self.app_context.pop()

    def init_user(self):
        self.create_user( "test@example.com", "testpassword")
        login_response = self.login("test@example.com", "testpassword")
        assert login_response.status_code == 200, (login_response.status_code, login_response.data)

    def init_tests(self):
        pass

    def create_user(self, email, password):
        try:
            user = User(email=email)
            user.set_password(password)
            self.db.add(user)
            self.db.commit()
        except:
            self.db.rollback()
            raise

    def login(self, email, password):
        return self.client.post('/api/login', json=dict(
            email=email,
            password=password
        ), follow_redirects=True)

    def logout(self):
        return self.client.post('/api/logout', follow_redirects=True)

class MockResponse:
    def __init__(self, status_code, content=None):
        self.status_code = status_code
        self.content = content

    def json(self):
        return self.content
