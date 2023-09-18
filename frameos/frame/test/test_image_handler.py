import unittest
from unittest.mock import Mock, patch
from PIL import Image
from frame.image_handler import ImageHandler

class TestImageHandler(unittest.TestCase):

    def setUp(self):
        self.mock_logger = Mock()
        self.mock_socketio = Mock()
        self.mock_config = Mock()
        self.mock_config.device = None
        self.mock_config.width = None
        self.mock_config.height = None
        self.mock_config.rotate = 0
        self.mock_config.background_color = 'white'
        self.mock_config.scaling_mode = 'contain'
        self.mock_config.to_dict.return_value = {
            'device': None,
            'width': None,
            'height': None,
            'rotate': 0,
            'background_color': 'white',
            'scaling_mode': 'contain'
        }

        self.mock_app_handler = Mock()

        self.image_handler = ImageHandler(
            self.mock_logger, self.mock_socketio, self.mock_config, self.mock_app_handler)

    def test_verify_device_default_case(self):
        # Given the default setUp, it should set the device to web_only
        self.image_handler.verify_device()
        self.mock_logger.log.assert_called_with({
            'event': '@frame:device', "device": 'web_only', 'info': "Starting in WEB only mode."})

    @patch("os.access", return_value=True)
    @patch("frame.image_handler.get_framebuffer_info", return_value=(800, 600, 24, "RGB"))
    def test_verify_device_framebuffer_case(self, mock_get_framebuffer_info, mock_os_access):
        self.mock_config.device = 'framebuffer'
        self.image_handler.verify_device()

        self.mock_logger.log.assert_called_with({'event': '@frame:device', "device": 'framebuffer', 'info': "init done"})

    def test_are_images_equal_different_size(self):
        img1 = Image.new('RGB', (100, 100))
        img2 = Image.new('RGB', (101, 100))
        result = self.image_handler.are_images_equal(img1, img2)
        self.assertFalse(result)

    def test_are_images_equal_same_image(self):
        img1 = Image.new('RGB', (100, 100))
        img2 = Image.new('RGB', (100, 100))
        result = self.image_handler.are_images_equal(img1, img2)
        self.assertTrue(result)

    # ... Add more tests ...

if __name__ == "__main__":
    unittest.main()
