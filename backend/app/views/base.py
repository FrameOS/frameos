import gzip
import io
import json

from flask import Flask, current_app, flash, redirect, url_for, request, jsonify
from flask_login import current_user
from app import login_manager

def setup_base_routes(app: Flask):
    @login_manager.user_loader
    def load_user(user_id):
        from app.models import User
        return User.query.get(int(user_id))

    @login_manager.unauthorized_handler
    def unauthorized():
        if request.is_json or request.path.startswith('/api/'):
            return jsonify({'error': 'Unauthorized'}), 401

        from app.models import User  # Import here to avoid circular dependencies
        if User.query.first() is None:
            flash('Please register the first user!')
            return redirect(url_for('views.register.register'))
        else:
            flash('Please login!')
            return redirect('/login')

    @app.errorhandler(404)
    def not_found(e):
        if request.is_json or request.path.startswith('/api/'):
            return jsonify({'error': 'Not found'}), 404
        if not current_user.is_authenticated and not request.path.startswith('/login'):
            return redirect('/login')
        return current_app.send_static_file('index.html')

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
