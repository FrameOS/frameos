from flask import Flask
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from huey import RedisHuey
from threading import Thread
from gevent import monkey

monkey.patch_all()

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../fcp.db'
socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins="*", message_queue='redis://')
db = SQLAlchemy(app)
huey = RedisHuey('fcp', host='localhost', port=6379)

from . import models, views, tasks
