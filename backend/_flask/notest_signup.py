from app.tests.base import BaseTestCase
from app.models.user import User

class SignupTestCase(BaseTestCase):
    def init_user(self):
        pass

    def test_successful_signup(self):
        """Test signing up with valid data."""
        response = self.client.post('/api/signup', json={
            'email': 'test@example.com',
            'password': 'password123',
            'password2': 'password123'
        })
        # self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertTrue(data.get('success'))

        # Ensure the user is created in the database
        user = self.db.query(User).filter_by(email='test@example.com').first()
        self.assertIsNotNone(user)
        self.assertTrue(user.check_password('password123'))

    def test_signup_with_missing_data(self):
        """Test signup with missing email and password fields."""
        response = self.client.post('/api/signup', json={})
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertEqual(data['error'], 'Invalid input')

    def test_signup_with_password_mismatch(self):
        """Test signup when passwords do not match."""
        response = self.client.post('/api/signup', json={
            'email': 'test@example.com',
            'password': 'password123',
            'password2': 'differentpassword'
        })
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('errors', data)
        self.assertIn('password2', data['errors'])
        self.assertEqual(data['errors']['password2'], 'Passwords do not match.')

    def test_signup_only_one_user(self):
        """Test signup with an email that is already in use."""
        # Create an existing user
        user = User(email='test@example.com')
        user.set_password('password123')
        self.db.add(user)
        self.db.commit()
        response = self.client.post('/api/signup', json={
            'email': 'test@example.com',
            'password': 'newpassword',
            'password2': 'newpassword'
        })
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('error', data)
        self.assertEqual(data['error'], 'Only one user is allowed. Please login!')

    def test_signup_with_invalid_input(self):
        """Test signup with invalid JSON input."""
        response = self.client.post('/api/signup', data="Not a JSON")
        self.assertEqual(response.status_code, 415)
