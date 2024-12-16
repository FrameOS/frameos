from typing import Optional

import sentry_sdk
from sqlalchemy.exc import OperationalError

from flask import Flask, g
from flask_login import LoginManager
# from flask_migrate import Migrate
from app.config import Config, get_config
from sqlalchemy.orm import Session
from .database import SessionLocal

# Initialize extensions
login_manager = LoginManager()
login_manager.login_view = 'api.login'
# migrate = Migrate()

# Sentry setup
def initialize_sentry(app, db: Session):
    with app.app_context():
        from .models import get_settings_dict
        try:
            settings = get_settings_dict(db)
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

    with SessionLocal() as db:
        initialize_sentry(app, db)

    @app.before_request
    def create_session():
        g.db = SessionLocal()

    @app.teardown_request
    def remove_session(exception):
        db = getattr(g, 'db', None)
        if db is not None:
            db.close()

    # db.init_app(app)
    # with app.app_context():
    #     os.makedirs('../db', exist_ok=True)
    #     db.create_all()
    # migrate.init_app(app, db)

    login_manager.init_app(app)
    initialize_sentry(app, db)

    # from app.views.base import setup_base_routes
    # setup_base_routes(app, db)

    from app.api import api as api_blueprint
    # app.register_blueprint(api_blueprint, url_prefix='/api')
    app.register_blueprint(api_blueprint)

    return app
