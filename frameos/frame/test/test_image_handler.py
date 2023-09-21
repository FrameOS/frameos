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

    # def test_image_resizing_contain_mode(self):
    #     # Mock app handler to return an image of different dimensions
    #     img = Image.new('RGB', (2000, 1000))
    #     self.mock_app_handler.render.return_value = Mock(image=img, apps_ran=[], apps_errored=[])
    #
    #     # Configure to resize in "contain" mode
    #     self.mock_config.scaling_mode = 'contain'
    #     self.mock_config.width = 800
    #     self.mock_config.height = 600
    #
    #     self.image_handler.refresh_image('test_trigger')
    #     self.mock_logger.log.assert_called_with({
    #         'event': '@frame:resizing_image',
    #         'trigger': 'test_trigger',
    #         'old_width': 2000,
    #         'old_height': 1000,
    #         'new_width': 800,
    #         'new_height': 600,
    #         'scaling_mode': 'contain',
    #         'rotate': 0,
    #         'background_color': 'white'
    #     })

    def test_image_update_lock(self):
        # Simulate an ongoing image update
        self.image_handler.image_update_lock.acquire()

        # Trigger another image refresh
        self.image_handler.refresh_image('test_trigger')

        # Logger should state the refresh was ignored due to ongoing process
        self.mock_logger.log.assert_called_with({
            'event': '@frame:refresh_ignored_already_in_progress',
            'trigger': 'test_trigger',
        })

    # def test_refresh_image_error_handling(self):
    #     # Introduce an exception when rendering the image
    #     self.mock_app_handler.render.side_effect = Exception("Test error")
    #
    #     self.image_handler.refresh_image('test_trigger')
    #
    #     self.mock_logger.log.assert_called_with({
    #         'event': '@frame:refresh_error',
    #         'error': "Test error",
    #         'stacktrace': unittest.mock.ANY  # We're just checking if a stacktrace exists
    #     })


    # def test_verify_device_framebuffer(self):
    #     self.mock_config.device = 'framebuffer'
    #     self.image_handler.verify_device()
    #     self.mock_logger.log.assert_called_with({
    #         'event': '@frame:device',
    #         "device": 'framebuffer',
    #         'info': "init done"
    #     })

    # def test_verify_device_waveshare_epd(self):
    #     self.mock_config.device = 'waveshare.epd'
    #     self.image_handler.verify_device()
    #     self.mock_logger.log.assert_called_with({
    #         'event': '@frame:device',
    #         "device": 'waveshare.epd',
    #         'info': "init done"
    #     })
    #
    # def test_verify_device_inky_impression(self):
    #     self.mock_config.device = 'pimoroni.inky_impression'
    #     self.image_handler.verify_device()
    #     self.mock_logger.log.assert_called_with({
    #         'event': '@frame:device',
    #         "device": 'pimoroni.inky_impression',
    #         'info': "init done"
    #     })

    def test_are_images_equal_identical(self):
        img1 = Image.new('RGB', (100, 100))
        img2 = Image.new('RGB', (100, 100))
        self.assertTrue(self.image_handler.are_images_equal(img1, img2))

    def test_are_images_equal_different_sizes(self):
        img1 = Image.new('RGB', (100, 100))
        img2 = Image.new('RGB', (200, 200))
        self.assertFalse(self.image_handler.are_images_equal(img1, img2))

    def test_are_images_equal_minor_differences(self):
        img1 = Image.new('RGB', (100, 100))
        img2 = Image.new('RGB', (100, 100))
        img2.putpixel((50, 50), (255, 0, 0))  # Make a minor change
        self.assertFalse(self.image_handler.are_images_equal(img1, img2))

    def test_slow_update_image_on_frame_with_waveshare(self):
        img = Image.new('RGB', (100, 100))
        self.image_handler.ws = Mock()  # mock the WaveShare instance
        self.image_handler.slow_update_image_on_frame(img)
        self.image_handler.ws.display_image.assert_called_with(img)

    # def test_slow_update_image_on_frame_with_inky(self):
    #     img = Image.new('RGB', (100, 100))
    #     self.image_handler.inky = Mock()  # mock the Inky instance
    #     self.image_handler.slow_update_image_on_frame(img)
    #     self.image_handler.inky.set_image.assert_called_with(img, saturation=1)
    #     self.image_handler.inky.show.assert_called_once()

    def test_rotation_of_image(self):
        img = Image.new('RGB', (200, 100))
        self.mock_config.rotate = 90
        rotated_img = img.rotate(self.mock_config.rotate, expand=True)
        self.assertNotEqual(img.size, rotated_img.size)

    def test_image_update_lock_respected(self):
        self.image_handler.image_update_lock.acquire()
        self.image_handler.refresh_image('test_trigger')
        self.mock_logger.log.assert_called_with({
            'event': '@frame:refresh_ignored_already_in_progress',
            'trigger': 'test_trigger',
        })

    def test_background_task_initiated_on_refresh(self):
        self.image_handler.refresh_image('test_trigger')
        self.image_handler.socketio.start_background_task.assert_called_once()

    # def test_scaling_mode_contain(self):
    #     self.mock_config.scaling_mode = 'contain'
    #     img = Image.new('RGB', (200, 200))
    #     scaled_img = scale_contain(img, 100, 100, 'white')
    #     self.assertEqual(scaled_img.size, (100, 100))
    #
    # def test_scaling_mode_stretch(self):
    #     self.mock_config.scaling_mode = 'stretch'
    #     img = Image.new('RGB', (200, 200))
    #     scaled_img = scale_stretch(img, 100, 50)
    #     self.assertEqual(scaled_img.size, (100, 50))
    #
    # def test_scaling_mode_center(self):
    #     self.mock_config.scaling_mode = 'center'
    #     img = Image.new('RGB', (200, 200))
    #     scaled_img = scale_center(img, 100, 100, 'white')
    #     self.assertEqual(scaled_img.size, (100, 100))
    #
    # def test_scaling_mode_cover(self):
    #     self.mock_config.scaling_mode = 'cover'
    #     img = Image.new('RGB', (200, 200))
    #     scaled_img = scale_cover(img, 100, 50)
    #     self.assertEqual(scaled_img.size, (100, 50))


if __name__ == "__main__":
    unittest.main()
