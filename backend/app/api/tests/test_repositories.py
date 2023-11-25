import json
from unittest.mock import patch
from sqlalchemy.exc import SQLAlchemyError

from app.tests.base import BaseTestCase
from app import db
from app.models import Repository

class TestRepositoryAPI(BaseTestCase):

    def setUp(self):
        super().setUp()

    def test_create_repository(self):
        # Test the POST /repositories endpoint
        data = {
            'name': 'New Repository',
            'url': 'http://example.com/repo'
        }
        response = self.client.post('/api/repositories', json=data)
        self.assertEqual(response.status_code, 201)
        new_repo = Repository.query.filter_by(name='New Repository').first()
        self.assertIsNotNone(new_repo)

    def test_get_repositories(self):
        # Test the GET /repositories endpoint
        response = self.client.get('/api/repositories')
        self.assertEqual(response.status_code, 200)
        repositories = json.loads(response.data)
        self.assertIsInstance(repositories, list)

    def test_get_repository(self):
        # Test the GET /repositories/<repository_id> endpoint
        # Add a repository first
        repo = Repository(name='Test Repo', url='http://example.com/repo')
        db.session.add(repo)
        db.session.commit()

        response = self.client.get(f'/api/repositories/{repo.id}')
        self.assertEqual(response.status_code, 200)
        repository = json.loads(response.data)
        self.assertEqual(repository['name'], 'Test Repo')

    def test_update_repository(self):
        # Test the PATCH /repositories/<repository_id> endpoint
        # Add a repository first
        repo = Repository(name='Test Repo', url='http://example.com/repo')
        db.session.add(repo)
        db.session.commit()

        updated_data = {
            'name': 'Updated Repo',
            'url': 'http://example.com/new_repo'
        }
        response = self.client.patch(f'/api/repositories/{repo.id}', json=updated_data)
        self.assertEqual(response.status_code, 200)
        updated_repo = Repository.query.get(repo.id)
        self.assertEqual(updated_repo.name, 'Updated Repo')

    def test_delete_repository(self):
        # Test the DELETE /repositories/<repository_id> endpoint
        # Add a repository first
        repo = Repository(name='Test Repo', url='http://example.com/repo')
        db.session.add(repo)
        db.session.commit()

        response = self.client.delete(f'/api/repositories/{repo.id}')
        self.assertEqual(response.status_code, 200)
        deleted_repo = Repository.query.get(repo.id)
        self.assertIsNone(deleted_repo)


    def test_create_repository_invalid_input(self):
        data = {'url': 'http://example.com/repo'}  # Missing 'name'
        response = self.client.post('/api/repositories', json=data)
        self.assertEqual(response.status_code, 400)  # Assuming 400 for Bad Request

    def test_get_nonexistent_repository(self):
        response = self.client.get('/api/repositories/9999')  # Non-existent ID
        self.assertEqual(response.status_code, 404)

    def test_update_nonexistent_repository(self):
        data = {'name': 'Updated Repo', 'url': 'http://example.com/new_repo'}
        response = self.client.patch('/api/repositories/9999', json=data)
        self.assertEqual(response.status_code, 404)

    def test_delete_nonexistent_repository(self):
        response = self.client.delete('/api/repositories/9999')
        self.assertEqual(response.status_code, 404)

    def test_update_repository_invalid_input(self):
        # Add a repository first
        repo = Repository(name='Test Repo', url='http://example.com/repo')
        db.session.add(repo)
        db.session.commit()

        data = {}  # Empty data
        response = self.client.patch(f'/api/repositories/{repo.id}', json=data)
        self.assertEqual(response.status_code, 400)  # Assuming 400 for Bad Request

    def test_unauthorized_access(self):
        # Log out the user first
        self.logout()

        endpoints = [
            ('/api/repositories', 'POST', {'name': 'New Repo', 'url': 'http://example.com/repo'}),
            ('/api/repositories', 'GET', None),
            ('/api/repositories/1', 'GET', None),
            ('/api/repositories/1', 'PATCH', {'name': 'Updated Repo'}),
            ('/api/repositories/1', 'DELETE', None)
        ]
        for endpoint, method, data in endpoints:
            response = self.client.open(endpoint, method=method, json=data)
            self.assertEqual(response.status_code, 401)  # Unauthorized

    def test_get_repositories_exception_handling(self):
        with patch('app.models.Repository.query') as mock_query:
            mock_query.all.side_effect = SQLAlchemyError("Database error")
            response = self.client.get('/api/repositories')
            self.assertEqual(response.status_code, 500)  # Internal Server Error

    def test_create_repository_calls_update_templates(self):
        with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
            data = {'name': 'New Repository', 'url': 'http://example.com/repo'}
            response = self.client.post('/api/repositories', json=data)
            self.assertEqual(response.status_code, 201)
            mock_update_templates.assert_called_once()

    def test_get_repositories_calls_update_templates(self):
        with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
            response = self.client.get('/api/repositories')
            self.assertEqual(response.status_code, 200)
            if response.json:  # Assuming update_templates is called only when new repo is created
                mock_update_templates.assert_called_once()
            else:
                mock_update_templates.assert_not_called()

    def test_update_repository_calls_update_templates(self):
        # Add a repository first
        repo = Repository(name='Test Repo', url='http://example.com/repo')
        db.session.add(repo)
        db.session.commit()

        with patch('app.models.repository.Repository.update_templates') as mock_update_templates:
            data = {'name': 'Updated Repo', 'url': 'http://example.com/new_repo'}
            response = self.client.patch(f'/api/repositories/{repo.id}', json=data)
            self.assertEqual(response.status_code, 200)
            mock_update_templates.assert_called_once()


if __name__ == '__main__':
    import unittest
    unittest.main()
