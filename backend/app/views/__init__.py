from flask import Blueprint, current_app, send_from_directory
from flask_login import login_required

views = Blueprint('views', __name__)

@views.route("/", methods=["GET"])
@login_required
def index():
    return current_app.send_static_file('index.html')

@views.route('/images/<path:filename>')
@login_required
def custom_static(filename: str):
    return send_from_directory(current_app.static_folder + '/images', filename)

from .login import *
from .register import *