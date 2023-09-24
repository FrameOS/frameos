import traceback
import os

from flask_socketio import SocketIO
from threading import Lock
from PIL import Image, ImageChops

from .logger import Logger
from .config import Config
from .app_handler import AppHandler
from .image_utils import scale_cover, scale_contain, scale_stretch, scale_center, \
    image_to_framebuffer, get_framebuffer_info, try_to_disable_cursor_blinking
from .waveshare import WaveShare

FRAMEBUFFER_DRIVERS = ['framebuffer', 'pimoroni.hyperpixel2r']

class ImageHandler:
    def __init__(self, logger: Logger, socketio: SocketIO, config: Config, app_handler: AppHandler):
        self.logger = logger
        self.socketio = socketio
        self.current_image: Image = None
        self.next_image: Image = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False
        self.config: Config = config
        self.app_handler: AppHandler = app_handler
        self.inky = None # inky frames
        self.ws: WaveShare = None

        self.verify_device()

        config = self.config.to_dict()
        config.pop('server_host', None)
        config.pop('server_port', None)
        config.pop('server_api_key', None)
        config.pop('scenes', None)
        self.logger.log({ 'event': '@frame:config', **config })

    def verify_device(self):
        if self.config.device in FRAMEBUFFER_DRIVERS or self.config.device is None:
            try:
                if os.access('/dev/fb0', os.W_OK):
                    width, height, bits_per_pixel, color_format = get_framebuffer_info('/dev/fb0')
                    self.config.device = self.config.device or 'framebuffer'
                    self.config.width = width
                    self.config.height = height
                    self.config.color = f"{bits_per_pixel}bpp {color_format}"

                    try_to_disable_cursor_blinking()
                    self.logger.log({'event': '@frame:device', "device": self.config.device, 'info': "init done"})
                    return
                else:
                    raise Exception("No framebuffer device found.")
            except Exception as e:
                self.logger.log({'event': '@frame:device_error', "device": 'framebuffer', 'error': str(e), 'stacktrace': traceback.format_exc() })

        if self.config.device is None:
            self.config.device = 'web_only'

        if self.config.device.startswith('waveshare.epd'):
            try:
                self.ws = WaveShare(self.config.device.replace('waveshare.', ''), self.logger)
                self.ws.init_device()
                self.logger.log({'event': '@frame:device', "device": self.config.device, 'info': "init done"})
                return
            except Exception as e:
                self.logger.log({'event': '@frame:device_error', "device": self.config.device, 'error': str(e), 'stacktrace': traceback.format_exc() })

        if self.config.device == 'pimoroni.inky_impression' or self.config.device is None:
            try:
                from inky.auto import auto
                self.inky = auto()
                self.config.device = 'pimoroni.inky_impression'
                self.config.width = self.inky.resolution[0]
                self.config.height = self.inky.resolution[1]
                self.config.color = self.inky.colour
                self.logger.log({'event': '@frame:device', "device": self.config.device, 'info': "init done"})
                return
            except Exception as e:
                self.inky = None
                self.logger.log({'event': '@frame:device_error', "device": 'pimoroni.inky_impression', 'error': str(e), })

        self.logger.log({'event': '@frame:device', "device": 'web_only', 'info': "Starting in WEB only mode."})

        if self.config.width is None or self.config.height is None:
            self.config.width = 800
            self.config.height = 600

    def slow_update_image_on_frame(self, image):
        rotated_image = image
        if isinstance(self.config.rotate, int) and self.config.rotate != 0:
            rotated_image = image.rotate(self.config.rotate, expand=True)
        if self.ws is not None:
            self.ws.display_image(rotated_image)
        elif self.inky is not None:
            if rotated_image.width != self.inky.resolution[0] or rotated_image.height != self.inky.resolution[1]:
                self.logger.log({ 'event': '@frame:resolution_mismatch', 'inky_resolution': self.inky.resolution, 'image_resolution': (rotated_image.width, rotated_image.height) })
            self.inky.set_image(rotated_image, saturation=1)
            self.inky.show()
        elif self.config.device in FRAMEBUFFER_DRIVERS:
            image_to_framebuffer(rotated_image, logger=self.logger)

    def are_images_equal(self, img1: Image, img2: Image) -> bool:
        if img1.size != img2.size:
            return False
        return not ImageChops.difference(img1, img2).getbbox()

    def refresh_image(self, trigger: str):
        if not self.image_update_lock.acquire(blocking=False):
            self.logger.log({
                'event': '@frame:refresh_ignored_already_in_progress', 
                'trigger': trigger,
            })
            return

        def do_update():
            try:
                self.logger.log({ 'event': '@frame:refresh_image', 'trigger': trigger })
                self.image_update_in_progress = True

                requested_width = self.config.height if self.config.rotate in [90,270] else self.config.width
                requested_height = self.config.width if self.config.rotate in [90,270] else self.config.height

                self.next_image = Image.new(
                    'RGB', (requested_width, requested_height), color=self.config.background_color or 'white'
                )
                context = self.app_handler.dispatch_event('render', image=self.next_image)
                self.next_image, apps_ran, apps_errored = context.image, context.apps_ran, context.apps_errored
                
                if self.next_image is None:
                    self.logger.log({ 'event': '@frame:refresh_skipped', 'reason': 'no_image', 'apps_ran': apps_ran })
                else:
                    if self.config.width != self.next_image.width or self.config.height != self.next_image.height:
                        self.logger.log({ 
                            'event': '@frame:resizing_image', 
                            'trigger': trigger,
                            'old_width': self.next_image.width,
                            'old_height': self.next_image.height,
                            'new_width': requested_width,
                            'new_height': requested_height,
                            'scaling_mode': self.config.scaling_mode,
                            'rotate': self.config.rotate,
                            'background_color': self.config.background_color,
                        })
                        if self.config.scaling_mode == 'contain':
                            self.next_image = scale_contain(self.next_image, requested_width, requested_height, self.config.background_color)
                        elif self.config.scaling_mode == 'stretch':
                            self.next_image = scale_stretch(self.next_image, requested_width, requested_height)
                        elif self.config.scaling_mode == 'center':
                            self.next_image = scale_center(self.next_image, requested_width, requested_height, self.config.background_color)
                        else: # cover
                            self.next_image = scale_cover(self.next_image, requested_width, requested_height)

                    if self.current_image is None or not self.are_images_equal(self.next_image, self.current_image):
                        self.logger.log({ 'event': '@frame:refreshing_screen' })
                        self.socketio.sleep(0)  # Yield to the event loop to allow the message to be sent
                        self.slow_update_image_on_frame(self.next_image)
                        self.current_image = self.next_image
                        self.next_image = None
                        self.logger.log({ 'event': '@frame:refresh_done', 'apps_ran': apps_ran, **({'apps_errored': apps_errored} if len(apps_errored) > 0 else {}) })
                    else:
                        self.logger.log({ 'event': '@frame:refresh_skipped', 'reason': 'no_change', 'apps_ran': apps_ran, **({'apps_errored': apps_errored} if len(apps_errored) > 0 else {}) })
            except Exception as e:
                self.logger.log({ 'event': '@frame:refresh_error', 'error': str(e), 'stacktrace': traceback.format_exc()  })
            finally:
                self.image_update_in_progress = False
                self.image_update_lock.release()
        self.socketio.start_background_task(target=do_update)
