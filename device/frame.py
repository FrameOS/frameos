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
from io import BytesIO
from PIL import Image

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode='threading')
image_update_lock = Lock()
image_update_in_progress = False
current_image = None
reset_event = Event()
inky = None

def load_config(filename='frame.json'):
    """
    Load configuration from the given filename.
    """
    try:
        with open(filename, 'r') as file:
            return json.load(file)
    except Exception as e:
        print(f"Error loading configuration: {e}")
        return None

config = load_config()

# Custom logger to handle logs
def webhook_log_request(message):
    if config is None:
        return
    protocol = 'https' if config['api_port'] in [443, 8443] else 'http'
    url = f"{protocol}://{config['api_host']}:{config['api_port']}/api/log"
    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json"
    }
    data = { "message": message }
    try:
        requests.post(url, headers=headers, json=data)
    except Exception as e:
        print(f"Error sending log: {e}")

class LogHandler:
    def __init__(self, limit):
        self.logs = []
        self.limit = limit

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
        Thread(target=webhook_log_request, args=(message,)).start()

def get_image(url):
    response = requests.get(url)
    return response.content

def update_image_on_frame(content):
    image = Image.open(BytesIO(content))
    inky.set_image(image, saturation=1)
    inky.show()

def handle_button(pin):
    label = LABELS[BUTTONS.index(pin)]
    log_handler.add(f"Button {label} pressed")
    if label == 'A':
        refresh_image('button press')

def refresh_image(reason):
    global image_url, current_image, image_update_in_progress
    if not image_update_lock.acquire(blocking=False):
        log_handler.add(f"Update already in progress, ignoring request from {reason}")
        return
    log_handler.add(f"Updating image via {reason}")
    def do_update():
        global current_image, image_update_in_progress
        try:
            image_update_in_progress = True
            new_image = get_image(image_url)
            if current_image is None or hashlib.sha256(new_image).digest() != hashlib.sha256(current_image).digest():
                socketio.sleep(0)  # Yield to the event loop to allow the message to be sent
                update_image_on_frame(new_image)
                current_image = new_image
                log_handler.add(f"Image updated")
                socketio.emit('image_updated', {'data': 'Image updated'})
        finally:
            image_update_in_progress = False
            image_update_lock.release()
    socketio.start_background_task(do_update)


def update_image_on_schedule():
    global reset_event
    while True:
        reset_event.wait(5 * 60)  # wait for 5 minutes or until the reset event is set
        refresh_image('schedule')
        reset_event.clear()  # clear the event for the next round

@app.route('/')
def index():
    with open("index.html", "r") as file:
        content = file.read()
    return content

@app.route('/image')
def image():
    global current_image
    if current_image is None:
        return "No image"
    img_io = io.BytesIO(current_image)
    img_io.seek(0)
    return send_file(img_io, mimetype='image/jpeg')

@app.route('/logs')
def logs():
    return log_handler.get()

@app.route('/refresh')
def refresh():
    refresh_image('http call')
    return "OK"

@socketio.on('connect')
def test_connect():
    emit('log_updated', {'data': log_handler.get()})

log_handler = LogHandler(100)
log_handler.add(f"Starting FrameOS")

# Setup the Inky display
inky = auto(ask_user=True, verbose=True)
log_handler.add(f"Frame resolution: {inky.resolution[0]}x{inky.resolution[1]}")

# Setup the GPIO buttons
BUTTONS = [5, 6, 16, 24]
LABELS = ['A', 'B', 'C', 'D']
GPIO.setmode(GPIO.BCM)
GPIO.setup(BUTTONS, GPIO.IN, pull_up_down=GPIO.PUD_UP)

image_url = f"https://source.unsplash.com/random/{inky.resolution[0]}x{inky.resolution[1]}/?bird"
log_handler.add(f"Using image: {image_url}")

for pin in BUTTONS:
    GPIO.add_event_detect(pin, GPIO.FALLING, handle_button, bouncetime=250)

# start the scheduling thread
schedule_thread = Thread(target=update_image_on_schedule)
schedule_thread.start()

if __name__ == '__main__':
    refresh_image('bootup')
    socketio.run(app, host='0.0.0.0', port=8999)
