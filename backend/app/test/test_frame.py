import unittest
from app import db, app
from app.models import Frame, new_frame, update_frame, delete_frame, new_log, Log

# Using an in-memory SQLite DB for tests
from app.test.base import BaseTestCase

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
app.config['TESTING'] = True

class TestFrameModel(BaseTestCase):

    def setUp(self):
        self.client = app.test_client()
        self.app_context = app.app_context()
        self.app_context.push()
        db.create_all()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.app_context.pop()

    def test_frame_creation(self):
        frame = new_frame("pi@192.168.1.1:8999", "server_host.com", "device_test")
        self.assertEqual(frame.frame_host, "192.168.1.1")
        self.assertEqual(frame.frame_port, 8999)
        self.assertEqual(frame.ssh_user, "pi")
        self.assertEqual(frame.ssh_pass, "raspberry")
        self.assertEqual(frame.server_host, "server_host.com")
        self.assertEqual(frame.server_port, 8999)
        self.assertEqual(frame.device, "device_test")

    def test_frame_unique_constraint(self):
        new_frame("pi@192.168.1.1", "server_host.com", None)
        with self.assertRaises(Exception):
            new_frame("pi@192.168.1.1", "server_host.com", None)

    def test_frame_update(self):
        frame = new_frame("pi@192.168.1.1", "server_host.com", None)
        frame.frame_host = "updated_host.com"
        update_frame(frame)
        updated_frame = Frame.query.get(frame.id)
        self.assertEqual(updated_frame.frame_host, "updated_host.com")

    def test_frame_delete(self):
        frame = new_frame("pi@192.168.1.1", "server_host.com", None)
        result = delete_frame(frame.id)
        self.assertTrue(result)
        deleted_frame = Frame.query.get(frame.id)
        self.assertIsNone(deleted_frame)

    def test_to_dict_method(self):
        frame = new_frame("pi@192.168.1.1", "server_host.com", None)
        frame_dict = frame.to_dict()
        print(frame_dict)
        self.assertEqual(frame_dict['frame_host'], "192.168.1.1")
        self.assertEqual(frame_dict['frame_port'], 8999)
        self.assertEqual(frame_dict['ssh_user'], "pi")
        self.assertEqual(frame_dict['ssh_pass'], "raspberry")
        self.assertEqual(frame_dict['ssh_port'], 22)
        self.assertEqual(frame_dict['server_host'], "server_host.com")
        self.assertEqual(frame_dict['server_port'], 8999)
        self.assertEqual(frame_dict['device'], 'web_only')

    def test_get_frame_by_host(self):
        frame1 = new_frame("pi@192.168.1.1", "server_host.com", None)
        frame2 = new_frame("pi@192.168.1.2", "server_host.com", None)
        frames_from_host = Frame.query.filter_by(frame_host="192.168.1.1").all()
        self.assertIn(frame1, frames_from_host)
        self.assertNotIn(frame2, frames_from_host)

    def test_delete_nonexistent_frame(self):
        result = delete_frame(99999)  # Non-existent ID
        self.assertFalse(result)

    def test_max_frame_port_limit(self):
        with self.assertRaises(ValueError):
            new_frame("pi@192.168.1.1:70000", "server_host.com", None)

if __name__ == '__main__':
    unittest.main()
