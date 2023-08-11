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

class LogHandler:
    def __init__(self, config: Config, limit: int, socketio: SocketIO):
        self.config = config
        self.logs: list = []
        self.limit = limit
        self.socketio = socketio

    def webhook_log_request(self, message):
        if not self.config:
            return
        protocol = 'https' if self.config.get('api_port') in [443, 8443] else 'http'
        url = f"{protocol}://{self.config.get('api_host')}:{self.config.get('api_port')}/api/log"
        headers = {
            "Authorization": f"Bearer {self.config.get('api_key')}",
            "Content-Type": "application/json"
        }
        data = {"message": message}
        try:
            response = requests.post(url, headers=headers, json=data)
            response.raise_for_status()
        except requests.HTTPError as e:
            logging.error(f"Error sending log (HTTP {response.status_code}): {e}")
        except Exception as e:
            logging.error(f"Error sending log: {e}")

    def add(self, log):
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        log_message = f'{timestamp}: {log}'
        self.logs.append(log_message)
        self.socketio.emit('log_updated', {'data': log_message})
        self.async_log_request(log_message)
        if len(self.logs) > self.limit:
            self.logs.pop(0)

    def get(self):
        return "\n".join(self.logs[::-1])

    def async_log_request(self, message):
        """
        Send a log message to the specified API endpoint in a non-blocking manner.
        """
        Thread(target=self.webhook_log_request, args=(message,)).start()


class ImageHandler:
    def __init__(self, logger: LogHandler, socketio: SocketIO):
        self.inky = auto(ask_user=True, verbose=True)
        self.logger = logger
        self.socketio = socketio
        self.image_url: str = f"https://source.unsplash.com/random/{self.inky.resolution[0]}x{self.inky.resolution[1]}/?bird"
        self.current_image: bytes = None
        self.next_image: bytes = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False

        logger.add(f"Frame resolution: {self.inky.resolution[0]}x{self.inky.resolution[1]}")
        logger.add(f"Image URL: {self.image_url}")

    def download_url(self, url: str):
        response = requests.get(url)
        return response.content

    def slow_update_image_on_frame(self, content):
        image = Image.open(io.BytesIO(content))
        self.inky.set_image(image, saturation=1)
        self.inky.show()

    def refresh_image(self, reason: str):
        if not self.image_update_lock.acquire(blocking=False):
            self.logger.add(f"Update already in progress, ignoring request from {reason}")
            return

        def do_update():
            try:
                self.image_update_in_progress = True
                self.logger.add(f"Updating image: {reason}")
                self.next_image = self.download_url(self.image_url)
                self.logger.add(f"Downloaded: {self.image_url}")
                if self.current_image is None or hashlib.sha256(self.next_image).digest() != hashlib.sha256(self.current_image).digest():
                    self.socketio.sleep(0)  # Yield to the event loop to allow the message to be sent
                    self.slow_update_image_on_frame(self.next_image)
                    self.current_image = self.next_image
                    self.next_image = None
                    self.logger.add(f"Image updated") 
            finally:
                self.image_update_in_progress = False
                self.image_update_lock.release() 
        self.socketio.start_background_task(target=do_update)

class ButtonHandler:
    def __init__(self, logger: LogHandler, buttons: list, labels: list, image_handler: ImageHandler):
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
        self.logger.add(f"Button {label} pressed")  # Fixed logger reference
        if label == 'A':
            self.image_handler.refresh_image('button press')

class Scheduler:
    def __init__(self, image_handler: ImageHandler, reset_event: Event):
        self.image_handler = image_handler
        self.reset_event: Event = reset_event
        self.schedule_thread: Thread = Thread(target=self.update_image_on_schedule)
        self.schedule_thread.start()

    def update_image_on_schedule(self):
        while True:
            self.reset_event.wait(5 * 60)  # using the instance's reset_event
            self.image_handler.refresh_image('schedule')
            self.reset_event.clear()  # using the instance's reset_event


class Server:
    def __init__(self):
        self.config: Config = Config()
        self.app: Flask = Flask(__name__)
        self.app.config['SECRET_KEY'] = 'secret!'
        self.socketio: SocketIO = SocketIO(self.app, async_mode='threading')
        self.logger: LogHandler = LogHandler(self.config, 100, socketio=self.socketio)

        self.logger.add(f"Starting FrameOS")
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
            self.image_handler.refresh_image('http call')
            return "OK"

        @self.socketio.on('connect')
        def test_connect():
            emit('log_updated', {'data': self.logger.get()})

    def run(self):
        button_handler: ButtonHandler = ButtonHandler(self.logger, [5, 6, 16, 24], ['A', 'B', 'C', 'D'], self.image_handler)
        reset_event: Event = Event()
        scheduler: Scheduler = Scheduler(self.image_handler, reset_event)
        self.image_handler.refresh_image('bootup')
        self.socketio.run(self.app, host='0.0.0.0', port=8999)


if __name__ == '__main__':
    server = Server()
    try:
        server.run()
    except Exception as e:
        server.logger.add(traceback.format_exc())
        print(traceback.format_exc())