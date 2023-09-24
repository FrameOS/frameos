from evdev import InputDevice, ecodes, list_devices

from .app_handler import AppHandler
from .logger import Logger
from .image_handler import ImageHandler
import threading

class TouchClickHandler:
    def __init__(self, logger: Logger, image_handler: ImageHandler, app_handler: AppHandler):
        self.logger = logger
        self.image_handler = image_handler
        self.app_handler = app_handler
        self.device_paths = list_devices()
        self.devices = [InputDevice(path) for path in self.device_paths]
        self.logger.log({'event': '@frame:input_devices', 'devices': [dev.name for dev in self.devices]})
        self.thread = threading.Thread(target=self.run, daemon=True)  # daemon=True will allow the program to exit even if the thread is still running

    def start(self):
        self.thread.start()

    def run(self):
        for device in self.devices:
            self.logger.log({'event': '@frame:listening_device', 'device_name': device.name})
            device.grab()  # Grab the device to receive its events

            # Async event loop
            for event in device.read_loop():
                if event.type == ecodes.EV_KEY and event.code == ecodes.BTN_TOUCH and event.value == 1:
                    self.handle_touch_click()
                if event.type == ecodes.EV_KEY and event.code == ecodes.BTN_MOUSE and event.value == 1:
                    self.handle_mouse_click()

    def handle_touch_click(self):
        self.logger.log({'event': '@frame:touchscreen_pressed'})
        self.app_handler.dispatch_event('button_press')

    def handle_mouse_click(self):
        self.logger.log({'event': '@frame:mouse_clicked'})
        self.app_handler.dispatch_event('button_press')