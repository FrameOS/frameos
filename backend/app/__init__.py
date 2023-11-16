import secrets

from gevent import monkey

monkey.patch_all()
import sentry_sdk
import os
from flask import Flask
from flask_login import LoginManager
from flask_migrate import Migrate
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from huey import RedisHuey
from urllib.parse import urlparse

from redis import Redis


redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
parsed_url = urlparse(redis_url)
redis_host = parsed_url.hostname
redis_port = parsed_url.port or 6379
redis = Redis(host=redis_host, port=redis_port)

os.makedirs('../db', exist_ok=True)

TEST=0
DEBUG=0

app = Flask(__name__, static_folder='../../frontend/dist', static_url_path='/', template_folder='../templates')

if os.getenv('TEST', '').lower() in ['true', '1']:
    TEST=1
    # TODO: should this just be disabled? we're api first essentially
    app.config['WTF_CSRF_ENABLED'] = False
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
elif os.getenv('DEBUG', '').lower() in ['true', '1']:
    DEBUG=1
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../../db/frameos-dev.db'
else:
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../../db/frameos.db'
    if not os.getenv('SECRET_KEY'):
        raise Exception('SECRET_KEY environment variable must be set in production')

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY') or secrets.token_hex(32)

socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins="*", message_queue=redis_url)
db = SQLAlchemy(app)
migrate = Migrate(app, db)
huey = RedisHuey('fcp', host=redis_host, port=redis_port)

login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.init_app(app)

@login_manager.user_loader
def load_user(user_id):
    from .models import User
    return User.query.get(int(user_id))

from . import models, api, tasks

try:
    with app.app_context():
        settings = models.get_settings_dict()
        dsn = settings.get('sentry', {}).get('controller_dsn', None)
        if dsn:
            sentry_sdk.init(dsn=dsn, traces_sample_rate=1.0, profiles_sample_rate=1.0)
except Exception as e:
    print(e)
    pass
