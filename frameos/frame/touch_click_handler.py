from evdev import InputDevice, ecodes, list_devices, categorize

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
            x, y = None, None

            # Async event loop
            for event in device.read_loop():
                if event.type == ecodes.EV_ABS:
                    absinfo = categorize(event).event
                    if absinfo.axis == ecodes.ABS_X:
                        x = absinfo.value
                    elif absinfo.axis == ecodes.ABS_Y:
                        y = absinfo.value

                # If event is relative axis event, extract relative x, y coordinates
                elif event.type == ecodes.EV_REL:
                    relinfo = categorize(event).event
                    if relinfo.axis == ecodes.REL_X:
                        x = relinfo.value  # Replace with relative movement calculation if needed
                    elif relinfo.axis == ecodes.REL_Y:
                        y = relinfo.value  # Replace with relative movement calculation if needed

                elif event.type == ecodes.EV_KEY:
                    if event.code == ecodes.BTN_TOUCH and event.value == 1:
                        self.logger.log({'event': '@frame:touch_press'})
                        self.app_handler.dispatch_event('touch_press', payload={'x': x, 'y': y})
                    if event.code == ecodes.BTN_MOUSE and event.value == 1:
                        self.logger.log({'event': '@frame:mouse_click'})
                        self.app_handler.dispatch_event('mouse_click', payload={'x': x, 'y': y})
