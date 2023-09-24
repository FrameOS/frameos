import io
import traceback
from flask import Flask, send_file
from flask_socketio import SocketIO, emit
from typing import Optional, Any
from threading import Event

from .config import Config
from .logger import Logger
from .app_handler import AppHandler
from .image_handler import ImageHandler
from .button_handler import ButtonHandler
from .scheduler import Scheduler
from .touch_click_handler import TouchClickHandler


class Server:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger

        self.app: Flask = Flask(__name__)
        self.app.config['SECRET_KEY'] = 'secret!'
        self.socketio: SocketIO = SocketIO(self.app, async_mode='threading')
        self.logger.set_socketio(self.socketio)
        self.logger.log({ 'event': '@frame:startup' })

        self.app_handler: AppHandler = AppHandler(self.config, self.logger)
        self.image_handler: ImageHandler = ImageHandler(self.logger, self.socketio, self.config, self.app_handler)
        self.app_handler.register_image_handler(self.image_handler)
        self.app_handler.init()

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

        @self.app.route('/display_off')
        def display_off():
            self.image_handler.display_off()
            return "off"

        @self.app.route('/display_on')
        def display_on():
            self.image_handler.display_on()
            return "on"

        @self.socketio.on('connect')
        def test_connect():
            emit('log_event', {'logs': self.logger.get()})

    def run(self):
        if self.config.device == 'pimoroni.inky_impression':
            button_handler: ButtonHandler = ButtonHandler(self.logger, [5, 6, 16, 24], ['A', 'B', 'C', 'D'], self.image_handler)
        touch_handler = TouchClickHandler(self.logger, self.image_handler, self.app_handler)
        touch_handler.start()
        reset_event: Event = Event()
        scheduler: Scheduler = Scheduler(image_handler=self.image_handler, reset_event=reset_event, logger=self.logger, config=self.config)
        self.image_handler.refresh_image('bootup')
        self.logger.log({'event': '@frame/kiosk:start', 'message': 'Starting web kiosk server on port 8999'})
        self.socketio.run(self.app, host='0.0.0.0', port=8999, allow_unsafe_werkzeug=True)
