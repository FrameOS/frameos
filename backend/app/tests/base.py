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
        with cls.app.app_context():
            db.session.rollback()
            db.drop_all()
            db.create_all()
        # cls.setUp(cls)

    @classmethod
    def tearDownClass(cls):
        with cls.app.app_context():
            db.session.rollback()
            db.session.remove()
            db.drop_all()

    def setUp(self):
        # Set up a test request context for each test
        self.app_context = self.app.test_request_context()
        self.app_context.push()
        self.create_user("tester", "test@example.com", "testpassword")

    def tearDown(self):
        db.session.rollback()
        self.app_context.pop()

    def create_user(self, username, email, password):
        user = User(username=username, email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

    def login(self, username, password):
        return self.client.post('/api/login', data=dict(
            username=username,
            password=password
        ), follow_redirects=True)

    def logout(self):
        return self.client.get('/logout', follow_redirects=True)
