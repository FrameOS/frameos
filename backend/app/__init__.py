import gzip
import io
import json
from typing import Optional

from gevent import monkey
monkey.patch_all()

import sentry_sdk
import os
from sqlalchemy.exc import OperationalError

from flask import Flask, current_app, flash, redirect, url_for, request
from flask_login import current_user, LoginManager
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_socketio import SocketIO
from config import Config, get_config
from huey import RedisHuey
from urllib.parse import urlparse
from redis import Redis

# Initialize extensions
db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = 'views.login'
migrate = Migrate()
socketio = SocketIO(async_mode='gevent')

# Redis setup
def create_redis_connection():
    redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
    parsed_url = urlparse(redis_url)
    redis_host = parsed_url.hostname
    redis_port = parsed_url.port or 6379
    return Redis(host=redis_host, port=redis_port)

redis = create_redis_connection()
huey = RedisHuey('fcp', connection_pool=redis.connection_pool)

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
    socketio.init_app(app, cors_allowed_origins="*", message_queue=os.environ.get('REDIS_URL'))
    initialize_sentry(app)

    from .api import api as api_blueprint
    app.register_blueprint(api_blueprint, url_prefix='/api')

    from .views import views as views_blueprint
    app.register_blueprint(views_blueprint, url_prefix='/')

    @login_manager.user_loader
    def load_user(user_id):
        from .models import User
        return User.query.get(int(user_id))

    @app.errorhandler(404)
    def not_found(e):
        from app.models import User  # Import here to avoid circular dependencies
        if User.query.first() is None:
            flash('Please register the first user!')
            return redirect(url_for('views.register.register'))
        if current_user.is_authenticated:
            return current_app.send_static_file('index.html')
        else:
            flash('Please login!')
            return redirect(url_for('views.login'))

    @app.before_request
    def before_request():
        """
        Check if the incoming request is gzipped and decompress it if it is.
        """
        if request.headers.get('Content-Encoding') == 'gzip':
            compressed_data = io.BytesIO(request.get_data(cache=False))
            decompressed_data = gzip.GzipFile(fileobj=compressed_data, mode='rb').read()
            request._cached_data = decompressed_data
            request.get_json = lambda cache=False: json.loads(decompressed_data.decode('utf-8'))

    return app
