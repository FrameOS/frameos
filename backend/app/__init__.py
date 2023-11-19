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

@app.route("/", methods=["GET"])
def index():
    return app.send_static_file('index.html')

from . import models, api, tasks



# try:
#     with app.app_context():
#         settings = models.get_settings_dict()
#         dsn = settings.get('sentry', {}).get('controller_dsn', None)
#         if dsn:
#             sentry_sdk.init(dsn=dsn, traces_sample_rate=1.0, profiles_sample_rate=1.0)
# except Exception as e:
#     print(e)
#     pass






# # app/__init__.py
# from gevent import monkey
#
# monkey.patch_all()
# import sentry_sdk
# import os
# from sqlalchemy.exc import OperationalError
#
# from flask import Flask
# from flask_sqlalchemy import SQLAlchemy
# from flask_login import LoginManager
# from flask_migrate import Migrate
# from flask_socketio import SocketIO
# from config import Config
# from huey import RedisHuey
# from urllib.parse import urlparse
# from redis import Redis
#
# # Initialize extensions
# db = SQLAlchemy()
# login_manager = LoginManager()
# login_manager.login_view = 'login'
# migrate = Migrate()
# socketio = SocketIO(async_mode='gevent')
#
# # Redis setup
# def create_redis_connection():
#     redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
#     parsed_url = urlparse(redis_url)
#     redis_host = parsed_url.hostname
#     redis_port = parsed_url.port or 6379
#     return Redis(host=redis_host, port=redis_port)
#
# # Sentry setup
# def initialize_sentry(app):
#     with app.app_context():
#         from .models import get_settings_dict
#         try:
#             settings = get_settings_dict()
#             dsn = settings.get('sentry', {}).get('controller_dsn', None)
#         except OperationalError:
#             print("Could not get settings dict, db not initialized.")
#             return
#         if dsn:
#             sentry_sdk.init(dsn=dsn, traces_sample_rate=1.0, profiles_sample_rate=1.0)
#
# # Application Factory
# def create_app(config_class: Config = Config):
#     app = Flask(__name__, static_folder='../../frontend/dist', static_url_path='/', template_folder='../templates')
#     app.config.from_object(config_class)
#
#     db.init_app(app)
#     with app.app_context():
#         # os.makedirs('../db', exist_ok=True)
#
#         db.create_all()
#     login_manager.init_app(app)
#     migrate.init_app(app, db)
#     socketio.init_app(app, cors_allowed_origins="*", message_queue=os.environ.get('REDIS_URL'))
#     initialize_sentry(app)
#
#     redis = create_redis_connection()
#     huey = RedisHuey('fcp', connection_pool=redis.connection_pool)
#
#     from .api import api as api_blueprint
#     app.register_blueprint(api_blueprint, url_prefix='/api')
#
#     from .main import main as main_blueprint
#     app.register_blueprint(main_blueprint)
#
#     @login_manager.user_loader
#     def load_user(user_id):
#         from .models import User
#         return User.query.get(int(user_id))
#
#     return app
