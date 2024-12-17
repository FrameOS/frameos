# import gzip
# import io
# import json

# from flask import Flask, current_app, flash, redirect, request, jsonify
# from flask_login import current_user
# from app.flask import login_manager
# from sqlalchemy.orm import Session

# def has_first_user(db: Session):
#     from app.models import User
#     return db.query(User).first() is not None

# def setup_base_routes(app: Flask, db: Session):
#     @login_manager.user_loader
#     def load_user(user_id):
#         from app.models import User
#         return db.query(User).get(int(user_id))

#     @login_manager.unauthorized_handler
#     def unauthorized():
#         if request.is_json or request.path.startswith('/api/'):
#             return jsonify({'error': 'Unauthorized'}), 401

#         if has_first_user():
#             flash('Please login!')
#             return redirect('/login')
#         else:
#             flash('Please register the first user!')
#             return redirect('/signup')

#     @app.errorhandler(404)
#     def not_found(e):
#         if request.is_json or request.path.startswith('/api/'):
#             return jsonify({'error': 'Not found'}), 404
#         if not current_user.is_authenticated:
#             if request.path.startswith('/signup'):
#                 if has_first_user():
#                     return redirect('/login')
#             elif request.path.startswith('/login'):
#                 if not has_first_user():
#                     return redirect('/signup')
#             else:
#                 if has_first_user():
#                     flash('Please login!')
#                     return redirect('/login')
#                 else:
#                     flash('Please register the first user!')
#                     return redirect('/signup')
#         return current_app.send_static_file('index.html')

#     @app.before_request
#     def before_request():
#         """
#         Check if the incoming request is gzipped and decompress it if it is.
#         """
#         if request.headers.get('Content-Encoding') == 'gzip':
#             compressed_data = io.BytesIO(request.get_data(cache=False))
#             decompressed_data = gzip.GzipFile(fileobj=compressed_data, mode='rb').read()
#             request._cached_data = decompressed_data
#             request.get_json = lambda cache=False: json.loads(decompressed_data.decode('utf-8'))
