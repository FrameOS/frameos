from flask import Flask
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from huey import RedisHuey
from threading import Thread
import eventlet

eventlet.monkey_patch()

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../fcp.db'
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*", message_queue='redis://')
db = SQLAlchemy(app)
huey = RedisHuey('fcp', host='localhost', port=6379)

from . import models, views, tasks
