from typing import Optional

from gevent import monkey
monkey.patch_all()

import sentry_sdk
import os
from sqlalchemy.exc import OperationalError

from flask import Flask
from flask_login import LoginManager
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_sock import Sock
from flask_socketio import SocketIO
from config import Config, get_config
from urllib.parse import urlparse
from redis import Redis

# Initialize extensions
db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = 'api.login'
migrate = Migrate()
socketio = SocketIO(async_mode='gevent')
sock = Sock()

DEFAULT_REDIS_URL = 'redis://localhost:6379/0'

# Redis setup
def create_redis_connection():
    redis_url = os.environ.get('REDIS_URL', DEFAULT_REDIS_URL)
    parsed_url = urlparse(redis_url)
    redis_host = parsed_url.hostname
    redis_port = parsed_url.port or 6379
    return Redis(host=redis_host, port=redis_port)

redis = create_redis_connection()

# Sentry setup
def initialize_sentry(app):
    with app.app_context():
        from .models import get_settings_dict
        try:
            settings = get_settings_dict()
            dsn = settings.get('sentry', {}).get('controller_dsn', None)
        except OperationalError:
            print("Could not get settings dict, db not initialized.")
            return
        if dsn:
            sentry_sdk.init(dsn=dsn, traces_sample_rate=1.0, profiles_sample_rate=1.0)

def create_app(config: Optional[Config] = None):
    config = config or get_config()
    app = Flask(__name__, static_folder='../../frontend/dist', static_url_path='/', template_folder='../templates')
    app.config.from_object(config)
    db.init_app(app)
    with app.app_context():
        os.makedirs('../db', exist_ok=True)

        db.create_all()
    login_manager.init_app(app)
    migrate.init_app(app, db)
    sock.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*", message_queue=os.environ.get('REDIS_URL', DEFAULT_REDIS_URL))
    initialize_sentry(app)

    from app.views.base import setup_base_routes
    setup_base_routes(app)

    from app.api import api as api_blueprint
    app.register_blueprint(api_blueprint, url_prefix='/api')

    from app.views import views as views_blueprint
    app.register_blueprint(views_blueprint, url_prefix='/')

    return app
