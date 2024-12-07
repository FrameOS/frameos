from app.models.frame import new_frame
from app.models.log import process_log, new_log, Log
from app.tests.base import BaseTestCase
from sqlalchemy.exc import IntegrityError

class TestModelsLog(BaseTestCase):

    def setUp(self):
        super().setUp()
        self.frame = new_frame("frame", "pi@192.168.1.1:8787", "server_host.com", "device_test")

    def test_log_creation(self):
        log = new_log(self.frame.id, "info", "This is a test log message.")
        self.assertEqual(log.type, "info")
        self.assertEqual(log.line, "This is a test log message.")
        self.assertEqual(log.frame_id, self.frame.id)

    def test_log_to_dict_method(self):
        log = new_log(self.frame.id, "warning", "Log to test to_dict method.")
        log_dict = log.to_dict()
        self.assertEqual(log_dict['type'], "warning")
        self.assertEqual(log_dict['line'], "Log to test to_dict method.")
        self.assertEqual(log_dict['frame_id'], self.frame.id)

    def test_old_logs_removal(self):
        from app import db
        for old_log in Log.query.all():
            db.session.delete(old_log)
        for i in range(1101):
            new_log(self.frame.id, "debug", f"Log number {i}")
        logs_count = Log.query.filter_by(frame_id=self.frame.id).count()
        self.assertEqual(logs_count, 1001)  # 1101 - 100 = 1001

    def test_process_log(self):
        process_log(self.frame, {'event': 'render'})
        self.assertEqual(self.frame.status, "preparing")
        process_log(self.frame, {'event': 'render:done'})
        self.assertEqual(self.frame.status, "ready")

    def test_log_without_frame(self):
        with self.assertRaises(IntegrityError):
            new_log(None, "info", "Log without frame.")

    def test_log_timestamp(self):
        log = new_log(self.frame.id, "info", "Testing log timestamp.")
        self.assertIsNotNone(log.timestamp)

    def test_different_log_types(self):
        types = ["info", "warning", "error", "debug"]
        for type in types:
            log = new_log(self.frame.id, type, f"This is a {type} log.")
            self.assertEqual(log.type, type)

    def test_process_log_events(self):
        events = [
            ('render', 'preparing'),
            ('render:device', 'rendering'),
            ('render:done', 'ready'),
            ('config', 'ready')  # Assuming the frame was not 'ready' before
        ]

        for event, expected_status in events:
            process_log(self.frame, {'event': event})
            self.assertEqual(self.frame.status, expected_status)
