import json

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


if __name__ == '__main__':
    import unittest
    unittest.main()
