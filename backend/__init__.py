import os
from flask import Flask
from flask_migrate import Migrate
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from huey import RedisHuey
from threading import Thread
from gevent import monkey
from urllib.parse import urlparse

# Get the Redis URL
redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
parsed_url = urlparse(redis_url)
redis_host = parsed_url.hostname
redis_port = parsed_url.port or 6379

monkey.patch_all()

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../data/fcp.db'

socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins="*", message_queue=redis_url)
db = SQLAlchemy(app)
migrate = Migrate(app, db)
huey = RedisHuey('fcp', host=redis_host, port=redis_port)

from . import models, views, tasks
