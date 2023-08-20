import traceback

from flask_socketio import SocketIO
from threading import Lock
from PIL import Image, ImageChops

from .logger import Logger
from .config import Config
from .apps import Apps
from .image_utils import scale_cover, scale_contain, scale_stretch, scale_center

class ImageHandler:
    def __init__(self, logger: Logger, socketio: SocketIO, config: Config, apps: Apps):
        self.logger = logger
        self.socketio = socketio
        self.current_image: Image = None
        self.next_image: Image = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False
        self.config: Config = config
        self.apps: Apps = apps

        try:
            from inky.auto import auto
            self.inky = auto()
            self.config.device = 'inky'
            self.config.width = self.inky.resolution[0]
            self.config.height = self.inky.resolution[1]
            self.config.color = self.inky.colour
        except Exception as e:
            logger.log({ 'event': '@frame:device_error', "device": 'inky', 'error': str(e), 'info': "Starting in WEB kiosk only mode." })
            self.inky = None
            self.config.device = 'web_only'
            if self.config.width is None or self.config.height is None:
                self.config.width = 1920
                self.config.height = 1080

        config = self.config.to_dict()
        config.pop('server_host', None)
        config.pop('server_port', None)
        config.pop('server_api_key', None)
        config_apps = config.pop('apps', None)
        logger.log({ 'event': '@frame:config', **config, 'apps': [{'keyword': app.keyword, 'config': app.config} for app in config_apps] })

    def slow_update_image_on_frame(self, image):
        if self.inky is not None:
            if image.width != self.inky.resolution[0] or image.height != self.inky.resolution[1]:
                self.logger.log({ 'event': '@frame:resolution_mismatch', 'inky_resolution': self.inky.resolution, 'image_resolution': (image.width, image.height) })

            self.inky.set_image(image, saturation=1)
            self.inky.show()

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
                self.next_image, apps_ran, apps_errored = self.apps.process_image(None, self.current_image)
                
                if self.next_image is None:
                    self.logger.log({ 'event': '@frame:refresh_skipped', 'reason': 'no_image', 'apps_ran': apps_ran })
                else:
                    if self.config.width != self.next_image.width or self.config.height != self.next_image.height:
                        self.logger.log({ 
                            'event': '@frame:resizing_image', 
                            'trigger': trigger,
                            'old_width': self.next_image.width,
                            'old_height': self.next_image.height,
                            'new_width': self.config.width,
                            'new_height': self.config.height,
                            'scaling_mode': self.config.scaling_mode,
                            'background_color': self.config.background_color,
                        })
                        if self.config.scaling_mode == 'contain':
                            self.next_image = scale_contain(self.next_image, self.config.width, self.config.height, self.config.background_color)
                        elif self.config.scaling_mode == 'stretch':
                            self.next_image = scale_stretch(self.next_image, self.config.width, self.config.height)
                        elif self.config.scaling_mode == 'center':
                            self.next_image = scale_center(self.next_image, self.config.width, self.config.height, self.config.background_color)
                        else: # cover
                            self.next_image = scale_cover(self.next_image, self.config.width, self.config.height)


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

