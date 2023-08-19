import io
import json
import requests
import hashlib
import logging
import traceback
import time
import atexit
import traceback
from queue import Queue, Empty

from datetime import datetime

from flask import Flask, send_file
from flask_socketio import SocketIO, emit
from typing import Optional, List, Dict, Any, Tuple
from threading import Lock, Thread, Event
from PIL import Image, ImageChops

from apps.apps import App, FrameConfig, ProcessImagePayload

VERSION = '1.0.0-prerelease'

class Config:
    def __init__(self, filename='frame.json'):
        self._data = self._load(filename)
        self.server_host: Optional[str] = self._data.get('server_host', None)
        self.server_port: Optional[int] = self._data.get('server_port', None)
        self.server_api_key: Optional[str] = self._data.get('server_api_key', None)
        self.width: int = self._data.get('width', 1920)
        self.height: int = self._data.get('height', 1080)
        self.device: str = self._data.get('device', "kiosk")
        self.color: Optional[str] = self._data.get('color', None)
        self.image_url: Optional[str] = self._data.get('image_url', None)
        self.interval: Optional[int] = self._data.get('interval', 300)

    def to_dict(self):
        return {
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'color': self.color,
            'image_url': self.image_url,
            'interval': self.interval
        }
    
    def to_frame_config(self):
        return FrameConfig(
            status='OK',
            version=VERSION,
            width=self.width,
            height=self.height,
            device=self.device,
            color=self.color,
            image_url=self.image_url,
            interval=self.interval
        )

    def _load(self, filename):
        try:
            with open(filename, 'r') as file:
                return json.load(file)
        except Exception as e:
            logging.error(f"Error loading configuration: {e}")
            return {}

    def get(self, key, default=None):
        return self._data.get(key, default)
    

class Webhook:
    def __init__(self, config: Config):
        self.config = config
        self.queue = Queue()
        self.stop_event = Event()
        self.thread = Thread(target=self._run)
        self.thread.start()

    def add_log(self, payload: Dict[str, Any]):
        self.queue.put(payload)

    def _run(self):
        while not self.stop_event.is_set():
            batch = []
            
            # Start by getting at least one item. This will block if the queue is empty.
            item = self.queue.get()
            batch.append(item)

            # Then try to fill the batch up to its max size without blocking
            for _ in range(99):
                try:
                    item = self.queue.get_nowait()
                    batch.append(item)
                except Empty:
                    break

            self._send_batch(batch)

    def _send_batch(self, batch: List[Dict[str, Any]]):
        if not self.config:
            return
        protocol = 'https' if self.config.server_port % 1000 == 443 else 'http'
        url = f"{protocol}://{self.config.server_host}:{self.config.server_port}/api/log"
        headers = {
            "Authorization": f"Bearer {self.config.server_api_key}",
            "Content-Type": "application/json"
        }
        try:
            response = requests.post(url, headers=headers, json={"logs": batch})
            response.raise_for_status()
        except requests.HTTPError as e:
            logging.error(f"Error sending logs (HTTP {response.status_code}): {e}")
        except Exception as e:
            logging.error(f"Error sending logs: {e}")

    def stop(self):
        self.stop_event.set()
        self.thread.join()


class Logger:
    def __init__(self, config: Config, limit: int, socketio: Optional[SocketIO] = None):
        self.config = config
        self.logs: List[Dict[str, Any]] = []
        self.limit = limit
        self.socketio = socketio
        self.webhook = Webhook(config)

    def set_socketio(self, socketio: SocketIO):
        self.socketio = socketio

    def log(self, payload: Dict[str, Any]):
        payload = {'timestamp': datetime.now().isoformat(), **payload}
        self.logs.append(payload)
        if self.socketio:
            self.socketio.emit('log_event', {'log': payload})
        self.webhook.add_log(payload)
        if len(self.logs) > self.limit:
            self.logs.pop(0)

    def get(self):
        return self.logs

    def stop(self):
        self.webhook.stop()


# in: frame/frame.py
class Apps:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger
        self.apps: Dict[str, App] = {}
        self.apps_configs: Dict[str, Dict] = {}
        self.process_image_apps: List[Tuple[str, App]] = []

        # Look at all the folders under '../apps/', and import them if they have a frame.py file
        # Each file will export one class that derives from App
        try:
            import os
            import importlib.util
            import inspect
            for folder in os.listdir('./apps/'):
                if os.path.isdir(f'./apps/{folder}') and os.path.isfile(f'./apps/{folder}/frame.py') and os.path.isfile(f'./apps/{folder}/config.json'): 
                    try:
                        with open(f'./apps/{folder}/config.json', 'r') as file:
                            config = json.load(file)
                            self.apps_configs[folder] = config
                        spec = importlib.util.spec_from_file_location(f"apps.{folder}", f"apps/{folder}/frame.py")
                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)
                        for name, obj in inspect.getmembers(module):
                            if inspect.isclass(obj) and issubclass(obj, App) and obj is not App:
                                app_instance = obj(name=name, frame_config=self.config.to_frame_config(), app_config={}, log_function=self.logger.log)
                                self.register(folder, app_instance)
                    except Exception as e:
                        self.logger.log({ 'event': f'{folder}:error_initializing', 'error': str(e), 'stacktrace': traceback.format_exc() })
        except Exception as e:
            self.logger.log({ 'event': f'@frame:error_initializing_apps', 'error': str(e), 'stacktrace': traceback.format_exc() })
    
    def register(self, name, app: App):
        self.apps[name] = app
        features = []
        if app.process_image is not App.process_image:
            self.process_image_apps.append((name, app))
            features.append('process_image')
        self.logger.log({ 'event': f'@frame:register_app', 'name': name, 'features': features })

    def process_image(self, next_image: Optional[Image.Image], current_image: Optional[Image.Image]) -> (Optional[Image.Image], List[str], List[str]):
        apps_ran=[]
        apps_errored=[]
        payload = ProcessImagePayload(next_image=next_image, current_image=current_image)
        for (name, app) in self.process_image_apps:
            try:
                self.logger.log({ 'event': f'{name}:process_image' })
                app.process_image(payload)
                apps_ran.append(name)
            except Exception as e:
                stacktrace = traceback.format_exc()
                self.logger.log({
                    'event': f'{name}:error_processing_image',
                    'app': name,
                    'apps_ran': apps_ran,
                    'error': str(e),
                    'stacktrace': stacktrace
                })
                apps_errored.append(name)
        return payload.next_image, apps_ran, apps_errored

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

        if self.config.image_url is None:
            self.config.image_url = "https://source.unsplash.com/random/{width}x{height}/?bird"

        config = self.config.to_dict()
        config.pop('server_host', None)
        config.pop('server_port', None)
        config.pop('server_api_key', None)
        logger.log({ 'event': '@frame:config', **config })

    def slow_update_image_on_frame(self, image):
        if self.inky is not None:
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
                elif self.current_image is None or not self.are_images_equal(self.next_image, self.current_image):
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

class ButtonHandler:
    def __init__(self, logger: Logger, buttons: list, labels: list, image_handler: ImageHandler):
        self.logger = logger
        self.buttons = buttons
        self.labels = labels
        self.image_handler = image_handler
        try:
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM)
            GPIO.setup(buttons, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            for pin in buttons:
                GPIO.add_event_detect(pin, GPIO.FALLING, self.handle_button, bouncetime=250)
        except Exception as e:
            logger.log({ 'event': '@frame:error_button_handler', 'error': str(e) })

    def handle_button(self, pin):
        label = self.labels[self.buttons.index(pin)]
        self.logger.log({ 'event': '@frame:button_pressed', 'label': label, 'pin': pin })
        if label == 'A':
            self.image_handler.refresh_image('button press')

class Scheduler:
    def __init__(self, image_handler: ImageHandler, reset_event: Event, logger: Logger, config: Config):
        self.logger = logger
        self.config = config
        self.image_handler = image_handler
        self.reset_event = reset_event
        self.schedule_thread: Thread = Thread(target=self.update_image_on_schedule)

        logger.log({ 'event': '@frame:schedule_start', 'interval': self.config.interval })
        self.schedule_thread.start()

    def update_image_on_schedule(self):
        while True:
            self.reset_event.wait(self.config.interval)  
            self.image_handler.refresh_image('schedule')
            self.reset_event.clear()  


class Server:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger

        self.app: Flask = Flask(__name__)
        self.app.config['SECRET_KEY'] = 'secret!'
        self.socketio: SocketIO = SocketIO(self.app, async_mode='threading')
        self.logger.set_socketio(self.socketio)
        self.logger.log({ 'event': '@frame:startup' })
        self.apps: Apps = Apps(self.config, self.logger)
        self.image_handler: ImageHandler = ImageHandler(self.logger, self.socketio, self.config, self.apps)
        self.saved_image: Optional[Any] = None
        self.saved_bytes: Optional[bytes] = None
        self.saved_format: Optional[str] = None

        @self.app.route('/')
        def index():
            with open("index.html", "r") as file:
                content = file.read()
            return content.replace('{_body_class_}', '')
        
        @self.app.route('/kiosk')
        def kiosk():
            with open("index.html", "r") as file:
                content = file.read()
            return content.replace('{_body_class_}', 'kiosk')

        @self.app.route('/image')
        def image():
            try:
                image = self.image_handler.next_image or self.image_handler.current_image or self.saved_image
                if image is None:
                    return "No image"
                
                if image != self.saved_image or self.saved_bytes is None:
                    self.saved_bytes = io.BytesIO()
                    self.saved_format = image.format or 'png'
                    image.save(self.saved_bytes, format=self.saved_format)

                self.saved_bytes.seek(0)
                return send_file(self.saved_bytes, mimetype=f'image/{self.saved_format.lower()}', as_attachment=False)
            except Exception as e:
                self.logger.log({ 'event': '@frame/kiosk:error_serving_image', 'error': str(e), 'stacktrace': traceback.format_exc() })

        @self.app.route('/logs')
        def logs():
            return self.logger.get()

        @self.app.route('/refresh')
        def refresh():
            self.image_handler.refresh_image('http trigger')
            return "OK"

        @self.socketio.on('connect')
        def test_connect():
            emit('log_event', {'logs': self.logger.get()})

    def run(self):
        button_handler: ButtonHandler = ButtonHandler(self.logger, [5, 6, 16, 24], ['A', 'B', 'C', 'D'], self.image_handler)
        reset_event: Event = Event()
        scheduler: Scheduler = Scheduler(image_handler=self.image_handler, reset_event=reset_event, logger=self.logger, config=config)
        self.image_handler.refresh_image('bootup')
        self.socketio.run(self.app, host='0.0.0.0', port=8999, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    config = Config()
    logger = Logger(config=config, limit=100)
    atexit.register(logger.stop)
    try:
        server = Server(config=config, logger=logger)
        server.run()
    except Exception as e:
        logger.log({ 'event': '@frame:error', 'error': traceback.format_exc() })
        print(traceback.format_exc())
