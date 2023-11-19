# app/main/routes.py
from . import main
from flask import current_app, send_from_directory, flash, redirect, url_for
from flask_login import login_required, current_user
import gzip
import io
import json
from flask import request

@main.route("/", methods=["GET"])
@login_required
def index():
    return current_app.send_static_file('index.html')

@main.route('/images/<path:filename>')
@login_required
def custom_static(filename: str):
    return send_from_directory(current_app.static_folder + '/images', filename)

@main.before_request
def before_request():
    """
    Check if the incoming request is gzipped and decompress it if it is.
    """
    if request.headers.get('Content-Encoding') == 'gzip':
        compressed_data = io.BytesIO(request.get_data(cache=False))
        decompressed_data = gzip.GzipFile(fileobj=compressed_data, mode='rb').read()
        request._cached_data = decompressed_data
        request.get_json = lambda cache=False: json.loads(decompressed_data.decode('utf-8'))

@main.errorhandler(404)
def not_found(e):
    from app.models import User  # Import here to avoid circular dependencies
    if User.query.first() is None:
        flash('Please register the first user!')
        return redirect(url_for('main.register'))
    if current_user.is_authenticated:
        return current_app.send_static_file('index.html')
    else:
        flash('Please login!')
        return redirect(url_for('main.login'))