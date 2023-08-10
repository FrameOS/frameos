import io
import requests
import hashlib
import time
from flask import Flask, render_template, send_file
from flask_socketio import SocketIO, emit
from threading import Lock
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode='threading')

# Custom logger to handle logs
class LogHandler:
    def __init__(self, limit):
        self.logs = []
        self.limit = limit

    def add(self, log):
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        log_message = f'{timestamp}: {log}'
        self.logs.append(log_message)
        socketio.emit('log_updated', {'data': log_message})
        if len(self.logs) > self.limit:
            self.logs.pop(0)

    def get(self):
        return "\n".join(self.logs[::-1])

log_handler = LogHandler(100)

current_image = None
image_update_in_progress = False
image_update_lock = Lock()
image_url = 'https://source.unsplash.com/random/800x480/?bird'

def get_image(url):
    response = requests.get(url)
    return response.content

def update_image_on_frame(image):
    time.sleep(10)

@app.route('/')
def index():
    return render_template('index.html')

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

@app.route('/button-press')
def button_press():
    refresh_image('button press')
    return "Button pressed"

@app.route('/refresh')
def refresh():
    refresh_image('external refresh')
    return "Image refreshed"

@socketio.on('connect')
def test_connect():
    emit('log_updated', {'data': log_handler.get()})

def refresh_image(reason):
    global image_url, current_image, image_update_in_progress
    if not image_update_lock.acquire(blocking=False):
        log_handler.add(f"Update already in progress, ignoring request from {reason}")
        return
    log_handler.add(f"Updating image via {reason}...")
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

if __name__ == '__main__':
    # current_image = get_image(image_url)
    refresh_image('bootup')
    socketio.run(app, host='0.0.0.0', port=8999)
