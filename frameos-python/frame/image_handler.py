import subprocess
import time
import traceback
import os

from flask_socketio import SocketIO
from threading import Lock
from PIL import Image

from .logger import Logger
from .config import Config
from .app_handler import AppHandler
from .image_utils import scale_cover, scale_contain, scale_stretch, scale_center, \
    image_to_framebuffer, get_framebuffer_info, try_to_disable_cursor_blinking, scale_image
from .waveshare import WaveShare

FRAMEBUFFER_DRIVERS = ['framebuffer', 'pimoroni.hyperpixel2r']

class ImageHandler:
    def __init__(self, logger: Logger, socketio: SocketIO, config: Config, app_handler: AppHandler):
        self.logger = logger
        self.socketio = socketio
        self.current_image: Image = None
        self.next_image: Image = None
        self.kiosk_image: Image = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False
        self.config: Config = config
        self.app_handler: AppHandler = app_handler
        self.inky = None # inky frames
        self.ws: WaveShare = None
        self.is_display_on = True

        self.verify_device()

        config = self.config.to_dict()
        config.pop('server_host', None)
        config.pop('server_port', None)
        config.pop('server_api_key', None)
        config.pop('scenes', None)
        try:
            config['settings'] = list(config.get('settings', {}).keys())
        except:
            config['settings'] = []

        self.logger.log({ 'event': '@frame:config', **config })

    def display_on(self):
        if self.config.device == 'pimoroni.hyperpixel2r':
            import RPi.GPIO as GPIO
            GPIO.cleanup()
        elif self.config.device == 'framebuffer':
            subprocess.run(['vcgencmd', 'display_power', '1'])

        self.is_display_on = True

    def display_off(self):
        if self.config.device == 'pimoroni.hyperpixel2r':
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM)
            pin = 19
            GPIO.setup(pin, GPIO.OUT)
            pwm = GPIO.PWM(pin, 1000)
            pwm.start(0)
            pwm.stop()
        elif self.config.device == 'framebuffer':
            subprocess.run(['vcgencmd', 'display_power', '0'])
        self.is_display_on = False

    def display_toggle(self) -> bool:
        if self.is_display_on:
            self.display_off()
            return True
        else:
            self.display_on()
            return False
