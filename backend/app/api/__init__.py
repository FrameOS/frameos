import gzip
from flask import send_from_directory

from .apps import *
from .frames import *
from .log import *
from .login import *
from .register import *
from .repositories import *
from .settings import *
from .templates import *

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

@app.errorhandler(404)
def not_found(e):
    if User.query.first() is None:
        flash('Please register the first user!')
        return redirect(url_for('register'))
    if current_user.is_authenticated:
        return app.send_static_file('index.html')
    else:
        flash('Please login!')
        return redirect(url_for('login'))

@app.route("/", methods=["GET"])
@login_required
def index():
    return app.send_static_file('index.html')

@app.route('/images/<path:filename>')
@login_required
def custom_static(filename: str):
    return send_from_directory(app.static_folder + '/images', filename)