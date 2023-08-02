from celery import Celery, Task
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO
import os

persistent_path = os.getenv("PERSISTENT_STORAGE_DIR", os.path.dirname(os.path.dirname(os.path.realpath(__file__))))

app = Flask(__name__)
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

app.config.from_mapping(
    CELERY=dict(
        broker_url="redis://localhost",
        result_backend="redis://localhost",
        task_ignore_result=True,
    ),
)

db_path = os.path.join(persistent_path, "sqlite.db")

app.config["SQLALCHEMY_DATABASE_URI"] = f'sqlite:///{db_path}'
app.config["SQLALCHEMY_ECHO"] = False
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy()

from app import views
from app import models

db.init_app(app)

with app.app_context():
    db.create_all() 

def celery_init_app(app: Flask) -> Celery:
    class FlaskTask(Task):
        def __call__(self, *args: object, **kwargs: object) -> object:
            with app.app_context():
                return self.run(*args, **kwargs)

    celery_app = Celery(app.name, task_cls=FlaskTask)
    celery_app.config_from_object(app.config["CELERY"])
    celery_app.set_default()
    app.extensions["celery"] = celery_app
    return celery_app

celery_app = celery_init_app(app)
