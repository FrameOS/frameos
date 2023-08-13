import io
import json
import requests
import hashlib
import logging
import traceback
import time
import atexit
from queue import Queue, Empty

from datetime import datetime

from flask import Flask, send_file
from flask_socketio import SocketIO, emit
from typing import Optional, List, Dict, Any
from threading import Lock, Thread, Event
from PIL import Image, ImageChops, ImageFilter

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

class ImageHandler:
    def __init__(self, logger: Logger, socketio: SocketIO, config: Config):
        self.logger = logger
        self.socketio = socketio
        self.current_image: bytes = None
        self.next_image: bytes = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False
        self.config: Config = config

        try:
            from inky.auto import auto
            self.inky = auto()
            self.config.device = 'inky'
            self.config.width = self.inky.resolution[0]
            self.config.height = self.inky.resolution[1]
            self.config.color = self.inky.colour
        except Exception as e:
            logger.log({ 'event': 'device_error', "device": 'inky', 'error': str(e), 'info': "Starting in WEB only mode." })
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
        logger.log({ 'event': 'config', **config })

    def download_url(self, url: str):
        response = requests.get(url)
        return response.content

    def slow_update_image_on_frame(self, content):
        if self.inky is not None:
            image = Image.open(io.BytesIO(content))
            self.inky.set_image(image, saturation=1)
            self.inky.show()

    def are_images_equal(self, img1_content: bytes, img2_content: bytes, fuzziness: int = 0) -> bool:
        """
        Check if two image contents are equal.
        :param img1_content: First image content as bytes.
        :param img2_content: Second image content as bytes.
        :param fuzziness: Intensity of fuzzy comparison. 0 for exact comparison.
        :return: True if images are considered equal, False otherwise.
        """
        with Image.open(io.BytesIO(img1_content)) as img1, Image.open(io.BytesIO(img2_content)) as img2:
            # Quick check if sizes are different
            if img1.size != img2.size:
                return False

            # Exact comparison
            if fuzziness == 0:
                return not ImageChops.difference(img1, img2).getbbox()

            # Fuzzy comparison
            img1 = img1.resize((32, 32)).convert('L').filter(ImageFilter.SMOOTH)
            img2 = img2.resize((32, 32)).convert('L').filter(ImageFilter.SMOOTH)
            diff = ImageChops.difference(img1, img2)
            return sum(diff.histogram()) <= fuzziness

    def refresh_image(self, trigger: str):
        if not self.image_update_lock.acquire(blocking=False):
            self.logger.log({
                'event': 'refresh_ignored_already_in_progress', 
                'trigger': trigger,
            })
            return

        def do_update():
            try:
                self.image_update_in_progress = True
                image_url = self.config.image_url.replace('{width}', str(self.config.width)).replace('{height}', str(self.config.height))
                self.logger.log({ 'event': 'refresh_image', 'trigger': trigger, 'image_url': image_url })
                self.next_image = self.download_url(image_url)
                if self.current_image is None or not self.are_images_equal(self.next_image, self.current_image, fuzziness=10):
                    self.logger.log({ 'event': 'refresh_begin' })
                    self.socketio.sleep(0)  # Yield to the event loop to allow the message to be sent
                    self.slow_update_image_on_frame(self.next_image)
                    self.current_image = self.next_image
                    self.next_image = None
                    self.logger.log({ 'event': 'refresh_end' })
                else:
                    self.logger.log({ 'event': 'refresh_skip_no_change' })
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
            logger.log({ 'event': 'error_button_handler', 'error': str(e) })

    def handle_button(self, pin):
        label = self.labels[self.buttons.index(pin)]
        self.logger.log({ 'event': 'button press', 'label': label, 'pin': pin })
        if label == 'A':
            self.image_handler.refresh_image('button press')

class Scheduler:
    def __init__(self, image_handler: ImageHandler, reset_event: Event, logger: Logger, config: Config):
        self.logger = logger
        self.config = config
        self.image_handler = image_handler
        self.reset_event = reset_event
        self.schedule_thread: Thread = Thread(target=self.update_image_on_schedule)

        logger.log({ 'event': 'schedule_start', 'interval': self.config.interval })
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
        self.logger.log({ 'event': 'startup' })
        self.image_handler: ImageHandler = ImageHandler(self.logger, self.socketio, self.config)

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
            image = self.image_handler.next_image or self.image_handler.current_image
            if image is None:
                return "No image"
            img_io = io.BytesIO(image)
            img_io.seek(0)
            return send_file(img_io, mimetype='image/jpeg')

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
        self.socketio.run(self.app, host='0.0.0.0', port=8999)


if __name__ == '__main__':
    config = Config()
    logger = Logger(config=config, limit=100)
    atexit.register(logger.stop)
    try:
        server = Server(config=config, logger=logger)
        server.run()
    except Exception as e:
        logger.log({ 'error': traceback.format_exc() })
        print(traceback.format_exc())
