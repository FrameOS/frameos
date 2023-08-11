import io
import json
import requests
import hashlib
import RPi.GPIO as GPIO
from flask import Flask, send_file
from flask_socketio import SocketIO, emit
from threading import Lock, Thread, Event
from datetime import datetime
from inky.auto import auto
from PIL import Image

app: Flask = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio: SocketIO = SocketIO(app, async_mode='threading')


def load_config(filename: str = 'frame.json') -> dict:
    try:
        with open(filename, 'r') as file:
            return json.load(file)
    except Exception as e:
        print(f"Error loading configuration: {e}")
        return {}


class LogHandler:
    def __init__(self, config: dict, limit: int):
        self.config = config
        self.logs: list = []
        self.limit = limit

    def webhook_log_request(self, message):
        if self.config is None:
            return
        protocol = 'https' if self.config['api_port'] in [443, 8443] else 'http'
        url = f"{protocol}://{self.config['api_host']}:{self.config['api_port']}/api/log"
        headers = {
            "Authorization": f"Bearer {self.config['api_key']}",
            "Content-Type": "application/json"
        }
        data = {"message": message}
        try:
            requests.post(url, headers=headers, json=data)
        except Exception as e:
            print(f"Error sending log: {e}")

    def add(self, log):
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        log_message = f'{timestamp}: {log}'
        self.logs.append(log_message)
        socketio.emit('log_updated', {'data': log_message})
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
    def __init__(self, inky, logger: LogHandler):
        self.inky = inky
        self.logger = logger
        self.image_url: str = f"https://source.unsplash.com/random/{inky.resolution[0]}x{inky.resolution[1]}/?bird"
        self.current_image: bytes = None
        self.image_update_lock: Lock = Lock()
        self.image_update_in_progress: bool = False

    def download_url(self, url):
        response = requests.get(url)
        return response.content

    def slow_update_image_on_frame(self, content):
        image = Image.open(io.BytesIO(content))
        self.inky.set_image(image, saturation=1)
        self.inky.show()

    def refresh_image(self, reason):
        if not self.image_update_lock.acquire(blocking=False):
            self.logger.add(f"Update already in progress, ignoring request from {reason}")
            return
        self.logger.add(f"Updating image via {reason}")

        def do_update():
            try:
                self.image_update_in_progress = True
                new_image = self.download_url(self.image_url)
                if self.current_image is None or hashlib.sha256(new_image).digest() != hashlib.sha256(self.current_image).digest():
                    socketio.sleep(0)  # Yield to the event loop to allow the message to be sent
                    self.slow_update_image_on_frame(new_image)
                    self.current_image = new_image
                    self.logger.add(f"Image updated") 
                    socketio.emit('image_updated', {'data': 'Image updated'})
            finally:
                self.image_update_in_progress = False
                self.image_update_lock.release() 
        socketio.start_background_task(target=do_update)

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
    image_handler: ImageHandler

    def __init__(self, app: Flask, socketio: SocketIO, logger: LogHandler, image_handler: ImageHandler):
        self.app = app
        self.socketio = socketio
        self.logger = logger
        self.image_handler = image_handler

        @self.app.route('/')
        def index():
            with open("index.html", "r") as file:
                content = file.read()
            return content

        @self.app.route('/image')
        def image():
            if self.image_handler.current_image is None:
                return "No image"
            img_io = io.BytesIO(self.image_handler.current_image)
            img_io.seek(0)
            return send_file(img_io, mimetype='image/jpeg')

        @self.app.route('/logs')
        def logs():
            return logger.get()

        @self.app.route('/refresh')
        def refresh():
            self.image_handler.refresh_image('http call')
            return "OK"

        @self.socketio.on('connect')
        def test_connect():
            emit('log_updated', {'data': logger.get()})

    def run(self):
        self.socketio.run(self.app, host='0.0.0.0', port=8999)


if __name__ == '__main__':
    config: dict = load_config()
    logger: LogHandler = LogHandler(config, 100)
    logger.add(f"Starting FrameOS")

    inky = auto(ask_user=True, verbose=True)
    logger.add(f"Frame resolution: {inky.resolution[0]}x{inky.resolution[1]}")

    image_handler: ImageHandler = ImageHandler(inky, logger)
    button_handler: ButtonHandler = ButtonHandler(logger, [5, 6, 16, 24], ['A', 'B', 'C', 'D'], image_handler)
    reset_event: Event = Event()
    scheduler: Scheduler = Scheduler(image_handler, reset_event)
    server: Server = Server(app, socketio, logger, image_handler)

    image_handler.refresh_image('bootup')
    server.run()
