#!/usr/bin/env python3

import sys
import signal
import time
import json
import threading
import requests
import RPi.GPIO as GPIO
import argparse
from flask import Flask, render_template_string
from flask_socketio import SocketIO, emit

from io import BytesIO
from PIL import Image
from collections import deque

from inky.auto import auto

app = Flask(__name__)
socketio = SocketIO(app)

# Queue to hold log messages
logs = deque(maxlen=50)

# Setup argument parser
parser = argparse.ArgumentParser(description='Update Inky display.')
parser.add_argument('--verbose', action='store_true', help='display verbose output', default=True)
parser.add_argument('--save', action='store_true', help='save generated image to disk', default=False)
parser.add_argument('--serve', action='store_true', help='start a webserver to live-stream logs', default=True)
args = parser.parse_args()

# Load the configuration from the 'frame.json' file.
config = None
try:
    with open('frame.json', 'r') as file:
        config = json.load(file)
except FileNotFoundError:
    print('Configuration file not found! Can\'t communicate with the control panel.')


def send_log_request(message):
    if config is None:
        return

    protocol = 'https' if config['api_port'] in [443, 8443] else 'http'
    url = f"{protocol}://{config['api_host']}:{config['api_port']}/api/log"

    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json"
    }

    data = {
        "message": message
    }

    try:
        requests.post(url, headers=headers, json=data)
    except Exception as e:
        print(f"Error sending log: {e}")


def api_log(message):
    """
    Send a log message to the specified API endpoint in a non-blocking manner.
    """
    threading.Thread(target=send_log_request, args=(message,)).start()

# Define log function that adds messages to the logs queue and emits them over the WebSocket
def log(message):
    logs.append(message)
    socketio.emit('log', message)
    api_log(message)
    if args.verbose:
        print(message)

# Define endpoints for Flask app
@app.route('/')
def index():
    return render_template_string('''
    <!DOCTYPE html>
    <html>
        <body>
            <script src="//cdnjs.cloudflare.com/ajax/libs/socket.io/4.0.1/socket.io.min.js"></script>
            <script>
                var socket = io.connect('http://' + document.domain + ':' + location.port);
                socket.on('log', function(msg) {
                    document.body.innerHTML += msg + '<br />';
                });
            </script>
        </body>
    </html>
    ''')

# Start Flask app in a new thread if --serve is specified
if args.serve:
    threading.Thread(target=socketio.run, args=(app,), kwargs={'port': 8999}, daemon=True).start()

# Setup the Inky display
inky = auto(ask_user=True, verbose=args.verbose)

log(f"Frame resolution: {inky.resolution[0]}x{inky.resolution[1]}")
image_url = f"https://source.unsplash.com/random/{inky.resolution[0]}x{inky.resolution[1]}/?bird"
log(f"Using image: {image_url}")

saturation = 1

# Setup the GPIO buttons
BUTTONS = [5, 6, 16, 24]
LABELS = ['A', 'B', 'C', 'D']
GPIO.setmode(GPIO.BCM)
GPIO.setup(BUTTONS, GPIO.IN, pull_up_down=GPIO.PUD_UP)

lock = threading.Lock()
reset_event = threading.Event()

saved_image = None

def update_image(request_source):
    global saved_image
    if lock.locked():
        if args.verbose:
            log(f"Update request from {request_source} rejected. An update is already in progress.")
        return

    with lock:
        if args.verbose:
            log(f"Image update requested by {request_source}, attempting to download new image...")

        response = requests.get(image_url)
        image = Image.open(BytesIO(response.content))
        resized_image = image.resize(inky.resolution)

        if saved_image is None or resized_image.tobytes() != saved_image.tobytes():
            if args.verbose:
                log("Downloaded new image, updating display...")
            inky.set_image(resized_image, saturation=saturation)
            inky.show()
            if args.verbose:
                log("Image updated")
            saved_image = resized_image
            if args.save:
                resized_image.save("image.png")
        else:
            if args.verbose:
                if saved_image is not None:
                    log("Downloaded image is the same as the existing image. Not updating the display.")
                else:
                    log("Error downloading image")

def handle_button(pin):
    if BUTTONS.index(pin) == 0: # the first button is pressed
        update_image('button press')
        reset_event.set()  # reset the timer

def update_image_on_schedule():
    while True:
        update_image('schedule')
        reset_event.wait(5 * 60)  # wait for 5 minutes or until the reset event is set
        reset_event.clear()  # clear the event for the next round

# add the event detect for the buttons
for pin in BUTTONS:
    GPIO.add_event_detect(pin, GPIO.FALLING, handle_button, bouncetime=250)

# start the scheduling thread
schedule_thread = threading.Thread(target=update_image_on_schedule)
schedule_thread.start()

# prevent the script from exiting
signal.pause()
