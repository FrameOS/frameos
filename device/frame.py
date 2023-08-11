import io
import json
import requests
import hashlib
import logging
import RPi.GPIO as GPIO
import traceback

from datetime import datetime
from inky.auto import auto
from PIL import Image

from flask import Flask, send_file
from flask_socketio import SocketIO, emit
from typing import Optional, List, Dict, Any
from threading import Lock, Thread, Event

class Config:
    def __init__(self, filename='frame.json'):
        self._data = self._load(filename)

    def _load(self, filename):
        try:
            with open(filename, 'r') as file:
                return json.load(file)
        except Exception as e:
            logging.error(f"Error loading configuration: {e}")
            return {}

    def get(self, key, default=None):
        return self._data.get(key, default)

class Logger:
    def __init__(self, config: Config, limit: int, socketio: Optional[SocketIO] = None):
        self.config = config
        self.logs: List[Dict[str, Any]] = []
        self.limit = limit
        self.socketio = socketio

    def set_socketio(self, socketio: SocketIO):
        self.socketio = socketio

    def webhook_log_request(self, payload: Dict[str, Any]):
        if not self.config:
            return
        protocol = 'https' if self.config.get('api_port') in [443, 8443] else 'http'
        url = f"{protocol}://{self.config.get('api_host')}:{self.config.get('api_port')}/api/log"
        headers = {
            "Authorization": f"Bearer {self.config.get('api_key')}",
            "Content-Type": "application/json"
        }
        try:
            response = requests.post(url, headers=headers, json={"log": payload})
            response.raise_for_status()
        except requests.HTTPError as e:
            logging.error(f"Error sending log (HTTP {response.status_code}): {e}")
        except Exception as e:
            logging.error(f"Error sending log: {e}")

    def log(self, payload: Dict[str, Any]):
        payload = {'timestamp': datetime.now().isoformat(), **payload}
        self.logs.append(payload)
        if self.socketio:
            self.socketio.emit('log_event', {'log': payload})
        self.async_log_request(payload)
        if len(self.logs) > self.limit:
            self.logs.pop(0)

    def get(self):
        return self.logs

    def async_log_request(self, payload: Dict[str, Any]):
        """
        Send a log payload to the specified API endpoint in a non-blocking manner.
        """
        Thread(target=self.webhook_log_request, args=(payload,)).start()


class ImageHandler:
    def __init__(self, logger: Logger, socketio: SocketIO):
        self.inky = auto(ask_user=True, verbose=True)
        self.logger = logger
        self.socketio = socketio
        self.image_url: str = f"https://source.unsplash.com/random/{self.inky.resolution[0]}x{self.inky.resolution[1]}/?bird"
        self.current_image: bytes = None
        self.next_image: bytes = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False

        logger.log({ 'event': 'frame_info', "device": 'inky', 'width': self.inky.resolution[0], 'height': self.inky.resolution[1] })

    def download_url(self, url: str):
        response = requests.get(url)
        if response.history:
            last_url = response.history[-1].url
        else:
            last_url = url
        return response.content, last_url

    def slow_update_image_on_frame(self, content):
        image = Image.open(io.BytesIO(content))
        self.inky.set_image(image, saturation=1)
        self.inky.show()

    def refresh_image(self, source: str):
        if not self.image_update_lock.acquire(blocking=False):
            self.logger.log({
                'event': 'refresh_ignored_already_in_progress', 
                'source': source,
            })
            return

        def do_update():
            try:
                self.image_update_in_progress = True
                self.logger.log({ 'event': 'refresh_image', 'source': source, 'image_url': self.image_url })
                self.next_image, last_url = self.download_url(self.image_url)
                if self.current_image is None or hashlib.sha256(self.next_image).digest() != hashlib.sha256(self.current_image).digest():
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
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(buttons, GPIO.IN, pull_up_down=GPIO.PUD_UP)
        for pin in buttons:
            GPIO.add_event_detect(pin, GPIO.FALLING, self.handle_button, bouncetime=250)

    def handle_button(self, pin):
        label = self.labels[self.buttons.index(pin)]
        self.logger.log({ 'event': 'button press', 'label': label, 'pin': pin })
        if label == 'A':
            self.image_handler.refresh_image('button press')

class Scheduler:
    def __init__(self, image_handler: ImageHandler, reset_event: Event, logger: Logger, interval: int):
        self.logger = logger
        self.interval = interval
        self.image_handler = image_handler
        self.reset_event = reset_event
        self.schedule_thread: Thread = Thread(target=self.update_image_on_schedule)

        logger.log({ 'event': 'schedule_info', 'image_url': self.image_handler.image_url, 'interval': self.interval })
        self.schedule_thread.start()

    def update_image_on_schedule(self):
        while True:
            self.reset_event.wait(self.interval)  
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
        self.image_handler: ImageHandler = ImageHandler(self.logger, self.socketio)

        @self.app.route('/')
        def index():
            with open("index.html", "r") as file:
                content = file.read()
            return content

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
        scheduler: Scheduler = Scheduler(image_handler=self.image_handler, reset_event=reset_event, logger=self.logger, interval=300)
        self.image_handler.refresh_image('bootup')
        self.socketio.run(self.app, host='0.0.0.0', port=8999)


if __name__ == '__main__':
    config = Config()
    logger = Logger(config=config, limit=100)
    try:
        server = Server(config=config, logger=logger)
        server.run()
    except Exception as e:
        logger.log({ 'error': traceback.format_exc() })
        print(traceback.format_exc())
